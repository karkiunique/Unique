import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { apiGet, apiPost, navigateTo } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  navigateTo: vi.fn()
}));

// No real network in tests.
vi.mock('../src/lib/api.js', () => ({
  api: { get: apiGet, post: apiPost, patch: vi.fn() },
  apiFetch: vi.fn()
}));

// Stubbed so nothing in the tree can actually navigate.
vi.mock('../src/lib/navigate.js', () => ({
  navigateTo,
  getQueryParam: () => null
}));

const { default: CampaignsPage } = await import('../src/pages/CampaignsPage.jsx');

const CAMPAIGNS = [
  {
    id: 'c-1',
    name: 'Series A founders',
    mode: 'voice',
    status: 'draft',
    created_at: '2026-08-01T09:00:00.000Z',
    sentCount: 12,
    repliedCount: 3
  },
  {
    id: 'c-2',
    name: 'Design agencies',
    mode: 'template',
    status: 'sending',
    created_at: '2026-08-02T09:00:00.000Z',
    sentCount: 0,
    repliedCount: 0
  }
];

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  navigateTo.mockReset();
  apiGet.mockResolvedValue({ campaigns: CAMPAIGNS });
});

describe('CampaignsPage', () => {
  it('loads the campaigns on mount', async () => {
    render(<CampaignsPage />);

    expect(await screen.findByText('Series A founders')).toBeInTheDocument();
    expect(screen.getByText('Design agencies')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/campaigns');
  });

  it('marks each campaign with its mode', async () => {
    render(<CampaignsPage />);

    await screen.findByText('Series A founders');

    const voice = screen.getByText('Voice');
    const template = screen.getByText('Template');

    expect(voice.closest('.reg-row')).toHaveTextContent('Series A founders');
    expect(template.closest('.reg-row')).toHaveTextContent('Design agencies');
  });

  it('shows the sent and replied counts, zero included', async () => {
    render(<CampaignsPage />);

    await screen.findByText('Series A founders');

    expect(screen.getByText('12 sent')).toBeInTheDocument();
    expect(screen.getByText('3 replied')).toBeInTheDocument();
    // A campaign with no leads reads as zero, not as blank.
    expect(screen.getByText('0 sent')).toBeInTheDocument();
    expect(screen.getByText('0 replied')).toBeInTheDocument();
  });

  it('shows each campaign status', async () => {
    const { container } = render(<CampaignsPage />);

    await screen.findByText('Series A founders');

    expect(screen.getByText('draft')).toBeInTheDocument();
    // 'sending' is the one status with something in motion.
    expect(container.querySelector('.camp-status.live')).toHaveTextContent('sending');
  });

  it('tallies replies against letters sent across the roll', async () => {
    const { container } = render(<CampaignsPage />);

    await screen.findByText('Series A founders');

    expect(container.querySelector('.tally').textContent).toBe('3/12');
  });

  it('renders a deliberate empty state when there are none', async () => {
    apiGet.mockResolvedValue({ campaigns: [] });

    const { container } = render(<CampaignsPage />);

    expect(await screen.findByText(/no campaigns yet/i)).toBeInTheDocument();
    expect(container.querySelectorAll('.reg-row')).toHaveLength(0);
    // Nothing has gone wrong — an empty roll is not an error.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('navigates to a campaign when its row is clicked', async () => {
    const user = userEvent.setup();

    render(<CampaignsPage />);
    await screen.findByText('Series A founders');

    await user.click(screen.getByText('Series A founders'));

    expect(navigateTo).toHaveBeenCalledWith('/campaigns/c-1');
  });

  it('opens the builder from New campaign', async () => {
    const user = userEvent.setup();

    render(<CampaignsPage />);
    await screen.findByText('Series A founders');

    await user.click(screen.getByRole('button', { name: /new campaign/i }));

    expect(navigateTo).toHaveBeenCalledWith('/campaigns/new');
  });

  it('renders the server message when the load fails', async () => {
    const err = new Error('Could not load your campaigns');
    err.status = 500;
    apiGet.mockRejectedValue(err);

    render(<CampaignsPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your campaigns');
  });

  it('renders only the campaigns the API returned', async () => {
    apiGet.mockResolvedValue({ campaigns: [CAMPAIGNS[0]] });

    const { container } = render(<CampaignsPage />);
    await screen.findByText('Series A founders');

    expect(container.querySelectorAll('.reg-row')).toHaveLength(1);
    expect(screen.queryByText('Design agencies')).not.toBeInTheDocument();
  });
});

describe('CampaignsPage — one campaign opened', () => {
  const DETAIL = {
    campaign: {
      ...CAMPAIGNS[0],
      sentCount: 1,
      repliedCount: 0,
      leads: [
        {
          id: 'l-1',
          email: 'sam@corp.com',
          first_name: 'Sam',
          last_name: 'Rivera',
          company: 'Corp',
          status: 'sent'
        }
      ]
    }
  };

  it('fetches and renders the campaign when one is open', async () => {
    apiGet.mockResolvedValue(DETAIL);

    render(<CampaignsPage campaignId="c-1" />);

    expect(await screen.findByText('Sam Rivera')).toBeInTheDocument();
    expect(screen.getByText('sam@corp.com')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/campaigns/c-1');
    // The roll is not fetched at the same time.
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it('reads a campaign that is not theirs as absent, not as a fault', async () => {
    const err = new Error('Campaign not found');
    err.status = 404;
    apiGet.mockRejectedValue(err);

    render(<CampaignsPage campaignId="c-someone-elses" />);

    expect(await screen.findByText(/isn't in your roll/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('goes back to the roll', async () => {
    apiGet.mockResolvedValue(DETAIL);
    const user = userEvent.setup();

    render(<CampaignsPage campaignId="c-1" />);
    await screen.findByText('Sam Rivera');

    await user.click(screen.getByRole('button', { name: /back to the roll/i }));

    expect(navigateTo).toHaveBeenCalledWith('/campaigns');
  });
});
