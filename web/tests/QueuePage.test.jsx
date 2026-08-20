import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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

/**
 * THE SEND PATH (CLAUDE.md, Decisions 2026-08-19).
 *
 * The promise is that a person reads each letter and sends it themselves. These
 * tests hold the three parts of that which are easiest to erode:
 *   - there is NO batch send anywhere on the screen;
 *   - Send is a CLICK and never a keystroke, because there is no unsend;
 *   - what the confirmation shows is exactly what gets posted.
 */
describe('sending a letter', () => {
  beforeEach(() => {
    queueReturns([LEAD]);
    apiPatch.mockResolvedValue({ id: 'lead-1', status: 'approved' });
  });

  it('offers no batch send, no send all, and no schedule', async () => {
    render(<QueuePage />);
    await screen.findByRole('button', { name: /Send this letter/ });

    for (const forbidden of [/send all/i, /send everything/i, /send \d+ letters/i, /schedule/i, /auto.?send/i]) {
      expect(screen.queryByRole('button', { name: forbidden })).not.toBeInTheDocument();
    }
  });

  it('does NOT send on Enter — approval is reversible, a send is not', async () => {
    render(<QueuePage />);
    const deck = await screen.findByRole('region', { name: 'Review deck' });

    deck.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{Enter}');

    // Neither approved nor sent by keystroke.
    expect(apiPatch).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('says nothing about an Enter shortcut in the legend', async () => {
    render(<QueuePage />);
    await screen.findByRole('button', { name: /Send this letter/ });

    const legend = screen.getByLabelText('Keyboard shortcuts');
    expect(legend.textContent).not.toMatch(/Enter/);
  });

  it('approves then shows the exact letter before anything is sent', async () => {
    render(<QueuePage />);
    await userEvent.click(await screen.findByRole('button', { name: /Send this letter/ }));

    // Approval is the precondition the server enforces; it is not the send.
    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith('/leads/lead-1', { approve: true }));
    // Nothing has left yet.
    expect(apiPost).not.toHaveBeenCalled();

    // The confirmation shows the real recipient and the real words — scoped to the
    // dialog, because the card behind it shows them too.
    const dialog = await screen.findByRole('dialog', { name: 'Confirm send' });
    expect(within(dialog).getByText('dana@district.org')).toBeInTheDocument();
    expect(within(dialog).getByText(/Twelve schools, one rollout/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Chromebook rollout/)).toBeInTheDocument();
  });

  it('posts to the LEAD route with exactly what was confirmed', async () => {
    apiPost.mockResolvedValue({ messageId: 'm1', threadId: 't1' });

    render(<QueuePage />);
    await userEvent.click(await screen.findByRole('button', { name: /Send this letter/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm send' });

    await userEvent.click(within(dialog).getByRole('button', { name: /Send from my Gmail/ }));

    await waitFor(() => {
      const call = apiPost.mock.calls.find(([path]) => String(path).includes('/send'));
      expect(call[0]).toBe('/leads/lead-1/send');
      expect(call[1]).toMatchObject({
        confirmed: true,
        subject: 'Twelve schools, one rollout'
      });
      expect(call[1].body).toContain('Chromebook rollout');
      // The lead route derives the recipient from the row, never the client.
      expect(call[1]).not.toHaveProperty('to');
    });
  });

  // "Keep editing" rather than "Cancel": backing out of a send should land you
  // where you can change the words, which is the hands-on half of the promise.
  it('can be backed out of at the confirmation without sending', async () => {
    render(<QueuePage />);
    await userEvent.click(await screen.findByRole('button', { name: /Send this letter/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm send' });

    await userEvent.click(within(dialog).getByRole('button', { name: /Keep editing/ }));

    expect(apiPost.mock.calls.filter(([p]) => String(p).includes('/send'))).toHaveLength(0);
  });
});
