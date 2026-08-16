import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * The daily review queue (CLAUDE.md, Decisions 2026-08-16).
 *
 * Two things carry this screen:
 *
 *  1. NOTHING SENDS ITSELF. The queue reuses the deck, so approval is still one
 *     explicit action per letter. A test asserts no send call is ever made from
 *     here.
 *  2. AN EMPTY QUEUE IS NORMAL. "~2 a day" is a ceiling, and a quiet day means
 *     nothing cleared the gates. The empty state must read as the product working,
 *     not as a failure — a user who reads it as broken will ask for the bar to be
 *     lowered, which is the one thing that must not happen.
 */

const { apiGet, apiPost, apiPatch, apiPut, navigateTo } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiPut: vi.fn(),
  navigateTo: vi.fn()
}));

vi.mock('../src/lib/api.js', () => ({
  api: { get: apiGet, post: apiPost, patch: apiPatch, put: apiPut },
  apiFetch: vi.fn()
}));

vi.mock('../src/lib/navigate.js', () => ({ navigateTo, getQueryParam: () => null }));

const { default: QueuePage } = await import('../src/pages/QueuePage.jsx');

const LEAD = {
  id: 'lead-1',
  email: 'dana@district.org',
  first_name: 'Dana',
  company: 'K12 District',
  status: 'generated',
  fidelity_score: 91
};

/**
 * The deck fetches the open letter through GET /leads/:id (2026-08-08 — one
 * letter at a time, never the whole roll), and the reject control stays disabled
 * until it has arrived. So the queue list alone is not enough to drive this
 * screen in a test.
 */
const LETTER = {
  lead: {
    ...LEAD,
    generated_subject: 'Twelve schools, one rollout',
    generated_body: 'Dana — saw the Chromebook rollout.\n\nWorth 15 minutes?\n\nUnique'
  }
};

function queueReturns(leads) {
  apiGet.mockImplementation((path) => {
    if (path === '/queue') return Promise.resolve({ campaignId: 'c1', leads });
    if (path.startsWith('/leads/')) return Promise.resolve(LETTER);
    return Promise.resolve({});
  });
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset().mockResolvedValue({ id: 'lead-1', status: 'rejected' });
  apiPatch.mockReset();
  apiPut.mockReset();
  navigateTo.mockReset();
});

describe('an empty queue', () => {
  it('reads as the product working, not as a failure', async () => {
    queueReturns([]);

    render(<QueuePage />);

    expect(await screen.findByRole('heading', { name: /Nothing waiting/ })).toBeInTheDocument();
    // The wording matters: a user who reads a quiet day as broken will ask for
    // the bar to be lowered.
    expect(screen.getByText(/nothing was good enough, which is the point/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('a queue with letters', () => {
  beforeEach(() => {
    queueReturns([LEAD]);
  });

  it('counts the letters waiting', async () => {
    render(<QueuePage />);

    expect(await screen.findByRole('heading', { name: '1 letter to review' })).toBeInTheDocument();
  });

  it('offers a rejection path, which the campaign deck does not', async () => {
    render(<QueuePage />);

    expect(await screen.findByRole('button', { name: /Not a fit/ })).toBeInTheDocument();
  });

  it('never sends anything from this screen', async () => {
    render(<QueuePage />);
    await screen.findByRole('button', { name: /Not a fit/ });

    const called = [...apiPost.mock.calls, ...apiPatch.mock.calls].map(([path]) => path);
    expect(called.some((path) => String(path).includes('/send'))).toBe(false);
  });
});

describe('rejecting a letter', () => {
  beforeEach(() => {
    queueReturns([LEAD]);
  });

  it('asks why before recording anything', async () => {
    render(<QueuePage />);

    await userEvent.click(await screen.findByRole('button', { name: /Not a fit/ }));

    expect(screen.getByText(/Telling us why sharpens/i)).toBeInTheDocument();
    // Nothing sent yet — the dialog is a question, not a confirmation.
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('will not submit without a reason', async () => {
    render(<QueuePage />);
    await userEvent.click(await screen.findByRole('button', { name: /Not a fit/ }));

    const submit = screen.getByRole('button', { name: /^Not a fit$/ });
    expect(submit).toBeDisabled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('posts the closed-set reason and drops the letter from the queue', async () => {
    render(<QueuePage />);
    await userEvent.click(await screen.findByRole('button', { name: /Not a fit/ }));

    await userEvent.click(screen.getByRole('radio', { name: /Wrong role/ }));
    await userEvent.click(screen.getByRole('button', { name: /^Not a fit$/ }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/leads/lead-1/reject', {
        reason: 'wrong_role',
        note: null
      })
    );

    // The list drives the deck, so removing the row is what advances it — and it
    // means a rejected letter cannot be approved by a stray Enter mid-refetch.
    expect(await screen.findByRole('heading', { name: /Nothing waiting/ })).toBeInTheDocument();
  });

  it('sends an optional note when one is written', async () => {
    render(<QueuePage />);
    await userEvent.click(await screen.findByRole('button', { name: /Not a fit/ }));

    await userEvent.click(screen.getByRole('radio', { name: /Something else/ }));
    await userEvent.type(screen.getByRole('textbox'), 'Already a customer');
    await userEvent.click(screen.getByRole('button', { name: /^Not a fit$/ }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/leads/lead-1/reject', {
        reason: 'other',
        note: 'Already a customer'
      })
    );
  });

  it('keeps the letter when the server refuses', async () => {
    apiPost.mockRejectedValue(new Error('Could not record the rejection'));

    render(<QueuePage />);
    await userEvent.click(await screen.findByRole('button', { name: /Not a fit/ }));
    await userEvent.click(screen.getByRole('radio', { name: /Bad timing/ }));
    await userEvent.click(screen.getByRole('button', { name: /^Not a fit$/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not record');
    // Not silently dropped from the user's queue when the server never took it.
    expect(screen.queryByRole('heading', { name: /Nothing waiting/ })).not.toBeInTheDocument();
  });

  it('can be cancelled without recording anything', async () => {
    render(<QueuePage />);
    await userEvent.click(await screen.findByRole('button', { name: /Not a fit/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(apiPost).not.toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: '1 letter to review' })).toBeInTheDocument();
  });
});
