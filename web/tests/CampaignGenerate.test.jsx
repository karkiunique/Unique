import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Starting the batch, and watching it run.
 *
 * The counts come off the leads the campaign detail already holds, so this
 * component asks the server for nothing and shows no letter — a drafted
 * recipient is one whose status has left `pending`, which is a status and not a
 * body.
 */

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

vi.mock('../src/lib/api.js', () => ({
  api: { get: apiGet, post: apiPost, patch: vi.fn() },
  apiFetch: vi.fn()
}));

const { default: CampaignGenerate } = await import('../src/components/CampaignGenerate.jsx');

const CAMPAIGN_ID = 'c-1';

function campaign(status, statuses) {
  return {
    id: CAMPAIGN_ID,
    name: 'Series A founders',
    mode: 'voice',
    status,
    leads: statuses.map((leadStatus, index) => ({ id: `l-${index}`, status: leadStatus }))
  };
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPost.mockResolvedValue({ campaignId: CAMPAIGN_ID, status: 'generating', pending: 2 });
});

describe('CampaignGenerate', () => {
  it('offers to draft the recipients still waiting', () => {
    render(<CampaignGenerate campaign={campaign('draft', ['pending', 'pending', 'generated'])} />);

    expect(screen.getByRole('button', { name: /draft 2 letters/i })).toBeEnabled();
    expect(screen.getByText(/1 of 3 drafted · 2 waiting/)).toBeInTheDocument();
  });

  it('starts the run and tells the page to re-read it', async () => {
    const user = userEvent.setup();
    const onStarted = vi.fn();

    render(
      <CampaignGenerate campaign={campaign('draft', ['pending'])} onStarted={onStarted} />
    );

    await user.click(screen.getByRole('button', { name: /draft 1 letter/i }));

    expect(apiPost).toHaveBeenCalledWith(`/campaigns/${CAMPAIGN_ID}/generate`, {});
    expect(onStarted).toHaveBeenCalled();
    // Nothing here reads a letter back.
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('shows progress instead of the button while a run is under way', () => {
    render(<CampaignGenerate campaign={campaign('generating', ['generated', 'pending'])} />);

    expect(screen.getByRole('status')).toHaveTextContent('1 of 2 done');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('says so when every recipient already has a draft', () => {
    render(<CampaignGenerate campaign={campaign('review', ['generated', 'approved'])} />);

    expect(screen.getByText(/every recipient has a draft/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders nothing at all before there are recipients', () => {
    const { container } = render(<CampaignGenerate campaign={campaign('draft', [])} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('never offers to draft while the campaign is sending', () => {
    render(<CampaignGenerate campaign={campaign('sending', ['pending', 'approved'])} />);

    expect(screen.getByRole('button', { name: /draft 1 letter/i })).toBeDisabled();
  });

  it("shows the server's refusal", async () => {
    const user = userEvent.setup();
    const err = new Error('There are no recipients waiting for a draft');
    err.status = 400;
    apiPost.mockRejectedValue(err);

    render(<CampaignGenerate campaign={campaign('draft', ['pending'])} />);

    await user.click(screen.getByRole('button', { name: /draft 1 letter/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('no recipients waiting');
  });

  it('states plainly that drafting is not sending', () => {
    render(<CampaignGenerate campaign={campaign('draft', ['pending'])} />);

    expect(screen.getByText(/drafting is not sending/i)).toBeInTheDocument();
  });
});
