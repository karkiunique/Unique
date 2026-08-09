import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * The review screen inside an opened campaign.
 *
 * Two things are load-bearing here. A letter is fetched only when a human opens
 * that one recipient — the list itself carries no bodies — and the list says
 * which letters have actually been read, because approval is per-letter and a
 * reviewer working down forty drafts needs to see where they got to.
 *
 * The polling is asserted in both directions: a run under way re-reads itself,
 * and a campaign that is not generating is read exactly once.
 */

const { apiGet, apiPatch, apiPost, navigateTo } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
  apiPost: vi.fn(),
  navigateTo: vi.fn()
}));

vi.mock('../src/lib/api.js', () => ({
  api: { get: apiGet, post: apiPost, patch: apiPatch },
  apiFetch: vi.fn()
}));

vi.mock('../src/lib/navigate.js', () => ({ navigateTo, getQueryParam: () => null }));

const { default: CampaignsPage } = await import('../src/pages/CampaignsPage.jsx');

const CAMPAIGN_ID = 'c-1';
const SUBJECT = 'a question about Blackwood';
const DRAFT = 'hey Marguerite\n\nsaw the raise go through. worth 15 minutes?\n\nthanks,\nAna';

const LEADS = [
  {
    id: 'l-1',
    email: 'marguerite@blackwood.example',
    first_name: 'Marguerite',
    last_name: 'Okonjo',
    company: 'Blackwood Holdings',
    status: 'generated',
    fidelity_score: 61
  },
  {
    id: 'l-2',
    email: 'sam@corp.example',
    first_name: 'Sam',
    last_name: 'Rivera',
    company: 'Corp',
    status: 'generated',
    fidelity_score: 94
  }
];

function detail(status = 'review', leads = LEADS) {
  return {
    campaign: {
      id: CAMPAIGN_ID,
      name: 'Series A founders',
      mode: 'voice',
      status,
      sentCount: 0,
      repliedCount: 0,
      leads
    }
  };
}

function leadPayload(overrides = {}) {
  return {
    lead: {
      id: 'l-1',
      campaign_id: CAMPAIGN_ID,
      email: 'marguerite@blackwood.example',
      first_name: 'Marguerite',
      last_name: 'Okonjo',
      status: 'generated',
      fidelity_score: 61,
      generated_subject: SUBJECT,
      generated_body: DRAFT,
      edited_body: null,
      ...overrides
    }
  };
}

/** One route, one payload — the campaign list and one opened letter are not the same read. */
function routeTo(campaignPayload) {
  return (path) =>
    Promise.resolve(path.startsWith('/leads/') ? leadPayload() : campaignPayload);
}

beforeEach(() => {
  apiGet.mockReset();
  apiPatch.mockReset();
  apiPost.mockReset();
  navigateTo.mockReset();
  apiGet.mockImplementation(routeTo(detail()));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the campaign review list', () => {
  it('lists the recipients without fetching a single letter', async () => {
    render(<CampaignsPage campaignId={CAMPAIGN_ID} />);

    expect(await screen.findByText('Marguerite Okonjo')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(apiGet).toHaveBeenCalledWith(`/campaigns/${CAMPAIGN_ID}`);
    expect(screen.queryByLabelText('Email body')).not.toBeInTheDocument();
  });

  it('marks every letter unread until it has actually been opened', async () => {
    const user = userEvent.setup();
    render(<CampaignsPage campaignId={CAMPAIGN_ID} />);

    await screen.findByText('Marguerite Okonjo');
    expect(screen.getAllByText('unread')).toHaveLength(2);

    await user.click(screen.getByText('Marguerite Okonjo'));

    expect(await screen.findByText('read')).toBeInTheDocument();
    // The other one is still work to do.
    expect(screen.getAllByText('unread')).toHaveLength(1);
  });

  it('fetches that one letter when its row is opened', async () => {
    const user = userEvent.setup();
    render(<CampaignsPage campaignId={CAMPAIGN_ID} />);

    await screen.findByText('Marguerite Okonjo');
    await user.click(screen.getByText('Marguerite Okonjo'));

    expect(await screen.findByDisplayValue(SUBJECT)).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/leads/l-1');
  });

  it('marks a low-fidelity draft in the list, before it is even opened', async () => {
    render(<CampaignsPage campaignId={CAMPAIGN_ID} />);

    await screen.findByText('Marguerite Okonjo');

    const flag = screen.getByText('low fidelity');
    expect(flag.closest('.reg-row')).toHaveTextContent('Marguerite Okonjo');
    // 94 is not a warning.
    expect(screen.getAllByText('low fidelity')).toHaveLength(1);
  });
});

describe('generation progress polling', () => {
  it('re-reads a run that is under way', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiGet.mockImplementation(routeTo(detail('generating', [{ ...LEADS[0], status: 'pending' }])));

    render(<CampaignsPage campaignId={CAMPAIGN_ID} />);

    await screen.findByText('Marguerite Okonjo');
    expect(apiGet).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2600);
    });

    expect(apiGet.mock.calls.length).toBeGreaterThan(1);
  });

  it('does not poll a campaign that is not generating', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    render(<CampaignsPage campaignId={CAMPAIGN_ID} />);

    await screen.findByText('Marguerite Okonjo');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });

    expect(apiGet).toHaveBeenCalledTimes(1);
  });
});
