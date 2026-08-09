import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
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

const { default: ThreadsPage } = await import('../src/pages/ThreadsPage.jsx');

const POLL_MS = 30000;
const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_LABEL = 'Search subject or recipient';
const REFRESH = { name: /refresh/i };

const THREADS = [
  {
    threadId: 't-1',
    subject: 'about the launch',
    to: 'sam@corp.com',
    sentAt: '2026-08-01T09:00:00.000Z',
    replied: true,
    replyCount: 1
  },
  {
    threadId: 't-2',
    subject: 'the pricing question',
    to: 'kim@other.com',
    sentAt: '2026-08-02T09:00:00.000Z',
    replied: false,
    replyCount: 0
  }
];

const SENT_BODY = 'hey Sam\n\nsaw the launch go out. worth 15 minutes next week?\n\nthanks,\nAna';
const REPLY_BODY = 'sure — how about Thursday?';

const DETAIL = {
  threadId: 't-1',
  messages: [
    {
      id: 'm-1',
      messageId: '<m1@mail.example>',
      from: 'Ana <ana@desk.com>',
      to: 'Sam <sam@corp.com>',
      subject: 'about the launch',
      sentAt: '2026-08-01T09:00:00.000Z',
      fromSelf: true,
      body: SENT_BODY
    },
    {
      id: 'm-2',
      messageId: '<m2@mail.example>',
      from: 'Sam <sam@corp.com>',
      to: 'Ana <ana@desk.com>',
      subject: 'Re: about the launch',
      sentAt: '2026-08-02T11:30:00.000Z',
      fromSelf: false,
      body: REPLY_BODY
    }
  ]
};

/** The poll timer, not whatever waitFor happens to schedule. */
function pollTimer(spy) {
  const index = spy.mock.calls.findIndex(([, delay]) => delay === POLL_MS);
  return { index, call: spy.mock.calls[index], id: spy.mock.results[index]?.value };
}

/** Fire the search debounce directly: deterministic, no wall-clock wait. */
function fireSearchDebounce(spy) {
  const scheduled = spy.mock.calls.filter(([, delay]) => delay === SEARCH_DEBOUNCE_MS);
  const latest = scheduled[scheduled.length - 1];
  if (!latest) throw new Error('the search scheduled no debounce timer');
  latest[0]();
}

/** A promise we can leave pending, so "in flight" is observable. */
function deferred() {
  const box = {};
  box.promise = new Promise((resolve, reject) => {
    box.resolve = resolve;
    box.reject = reject;
  });
  return box;
}

/** The register on /threads, one thread on /threads/:id. */
function routeApi({ threads = THREADS, detail = DETAIL, detailError } = {}) {
  apiGet.mockImplementation((path) => {
    if (path.startsWith('/threads/')) {
      return detailError ? Promise.reject(detailError) : Promise.resolve(detail);
    }
    return Promise.resolve({ threads });
  });
}

function requestedPaths() {
  return apiGet.mock.calls.map(([path]) => path);
}

async function openFirstThread(user) {
  await screen.findByText('about the launch');
  await user.click(screen.getByText('about the launch'));
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  navigateTo.mockReset();
  apiGet.mockResolvedValue({ threads: THREADS });
});

describe('ThreadsPage', () => {
  it('loads sent threads on mount', async () => {
    render(<ThreadsPage />);

    expect(await screen.findByText('about the launch')).toBeInTheDocument();
    expect(screen.getByText('the pricing question')).toBeInTheDocument();
    expect(screen.getByText('sam@corp.com')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/threads');
  });

  it('shows a Replied mark only on threads that were replied to', async () => {
    render(<ThreadsPage />);

    expect(await screen.findByText('about the launch')).toBeInTheDocument();

    const badges = screen.getAllByText('Replied');
    expect(badges).toHaveLength(1);
    // The mark belongs to the replied thread's row, not the other one.
    expect(badges[0].closest('.reg-row')).toHaveTextContent('about the launch');
  });

  it('tallies the replies against the total in the page head', async () => {
    const { container } = render(<ThreadsPage />);

    await screen.findByText('about the launch');

    expect(container.querySelector('.tally').textContent).toBe('1/2');
  });

  it('makes plain that this is reply detection on sent mail, not an inbox', async () => {
    render(<ThreadsPage />);

    expect(await screen.findByText(/not an inbox/i)).toBeInTheDocument();
  });

  it('renders an empty state when nothing has been sent', async () => {
    apiGet.mockResolvedValue({ threads: [] });

    render(<ThreadsPage />);

    expect(await screen.findByText('Nothing sent from here yet.')).toBeInTheDocument();
    expect(screen.queryByText('Replied')).not.toBeInTheDocument();
  });

  it('renders the server message when the load fails', async () => {
    const err = new Error('Gmail is not connected');
    err.status = 400;
    apiGet.mockRejectedValue(err);

    const { container } = render(<ThreadsPage />);

    expect(await screen.findByText('Gmail is not connected')).toBeInTheDocument();
    expect(container.querySelector('.error')).toHaveTextContent('Gmail is not connected');
  });

  it('polls every 30 seconds and clears the interval on unmount', async () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');

    const { unmount } = render(<ThreadsPage />);
    await screen.findByText('about the launch');

    const timer = pollTimer(setSpy);
    expect(timer.index).toBeGreaterThan(-1);
    expect(apiGet).toHaveBeenCalledTimes(1);

    // Fire the poll callback directly: no wall-clock wait, no fake-timer coupling.
    await act(async () => {
      timer.call[0]();
    });
    expect(apiGet).toHaveBeenCalledTimes(2);

    unmount();
    expect(clearSpy).toHaveBeenCalledWith(timer.id);
  });

  it('renders only the threads the API returned and invents none of its own', async () => {
    apiGet.mockResolvedValue({ threads: [THREADS[0]] });

    const { container } = render(<ThreadsPage />);
    await screen.findByText('about the launch');

    // "Only mail we sent" is the server's guarantee; the client neither pads the
    // list nor filters it further.
    expect(container.querySelectorAll('.reg-row')).toHaveLength(1);
    expect(screen.queryByText('the pricing question')).not.toBeInTheDocument();
  });
});

describe('ThreadsPage — searching the register', () => {
  it('debounces the search and calls /threads with the q param', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const user = userEvent.setup();

    render(<ThreadsPage />);
    await screen.findByText('about the launch');
    expect(apiGet).toHaveBeenCalledTimes(1);

    await user.type(screen.getByLabelText(SEARCH_LABEL), 'launch');

    // Six keystrokes, still one request: nothing is fired per key.
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(requestedPaths()).not.toContain('/threads?q=l');
    expect(requestedPaths()).not.toContain('/threads?q=la');

    await act(async () => {
      fireSearchDebounce(setTimeoutSpy);
    });

    expect(apiGet).toHaveBeenCalledTimes(2);
    expect(apiGet).toHaveBeenLastCalledWith('/threads?q=launch');
  });

  it('goes back to the unfiltered list when the box is cleared', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const user = userEvent.setup();

    render(<ThreadsPage />);
    await screen.findByText('about the launch');

    const box = screen.getByLabelText(SEARCH_LABEL);
    await user.type(box, 'launch');
    await act(async () => {
      fireSearchDebounce(setTimeoutSpy);
    });
    expect(apiGet).toHaveBeenLastCalledWith('/threads?q=launch');

    await user.clear(box);
    await act(async () => {
      fireSearchDebounce(setTimeoutSpy);
    });

    // An empty query carries no q at all, rather than q=''.
    expect(apiGet).toHaveBeenLastCalledWith('/threads');
  });

  it('ignores a stale search response that lands after a newer one', async () => {
    const slow = deferred();
    const fast = deferred();

    apiGet.mockImplementation((path) => {
      if (path === '/threads?q=a') return slow.promise;
      if (path === '/threads?q=ab') return fast.promise;
      return Promise.resolve({ threads: THREADS });
    });

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const user = userEvent.setup();

    render(<ThreadsPage />);
    await screen.findByText('about the launch');

    const box = screen.getByLabelText(SEARCH_LABEL);

    await user.type(box, 'a');
    await act(async () => {
      fireSearchDebounce(setTimeoutSpy);
    });

    await user.type(box, 'b');
    await act(async () => {
      fireSearchDebounce(setTimeoutSpy);
    });

    // The newer request answers first, then the older one arrives late.
    await act(async () => {
      fast.resolve({ threads: [{ ...THREADS[0], threadId: 't-9', subject: 'the newer match' }] });
      await fast.promise;
    });
    await act(async () => {
      slow.resolve({ threads: [{ ...THREADS[0], threadId: 't-8', subject: 'the stale match' }] });
      await slow.promise;
    });

    expect(screen.getByText('the newer match')).toBeInTheDocument();
    expect(screen.queryByText('the stale match')).not.toBeInTheDocument();
  });

  it('distinguishes an empty search result from having sent nothing', async () => {
    apiGet.mockImplementation((path) =>
      path === '/threads' ? Promise.resolve({ threads: THREADS }) : Promise.resolve({ threads: [] })
    );

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const user = userEvent.setup();

    render(<ThreadsPage />);
    await screen.findByText('about the launch');

    await user.type(screen.getByLabelText(SEARCH_LABEL), 'zzz');
    await act(async () => {
      fireSearchDebounce(setTimeoutSpy);
    });

    expect(await screen.findByText('No letter matches that search.')).toBeInTheDocument();
    expect(screen.queryByText('Nothing sent from here yet.')).not.toBeInTheDocument();
  });
});

describe('ThreadsPage — refreshing on demand, never under the reader', () => {
  it('refetches on demand when Refresh is clicked', async () => {
    const user = userEvent.setup();

    render(<ThreadsPage />);
    await screen.findByText('about the launch');
    expect(apiGet).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', REFRESH));

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(apiGet).toHaveBeenLastCalledWith('/threads');
  });

  it('says when the register was last updated', async () => {
    const { container } = render(<ThreadsPage />);

    await screen.findByText('about the launch');

    expect(container.querySelector('.reg-updated').textContent).toMatch(/^Updated /);
  });

  it('does NOT refresh the list while a thread is being read', async () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    routeApi();
    const user = userEvent.setup();

    render(<ThreadsPage />);
    await openFirstThread(user);
    await screen.findByText(/worth 15 minutes next week/);

    const before = apiGet.mock.calls.length;
    const timer = pollTimer(setSpy);

    await act(async () => {
      timer.call[0]();
      timer.call[0]();
    });

    // The timer fired twice and fetched nothing: reading is never interrupted.
    expect(apiGet).toHaveBeenCalledTimes(before);
    expect(screen.getByText(/worth 15 minutes next week/)).toBeInTheDocument();
  });

  it('resumes background refreshes once the reader goes back to the list', async () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    routeApi();
    const user = userEvent.setup();

    render(<ThreadsPage />);
    await openFirstThread(user);
    await screen.findByText(/worth 15 minutes next week/);

    await user.click(screen.getByRole('button', { name: /back to the register/i }));
    await screen.findByText('the pricing question');

    const before = apiGet.mock.calls.length;
    const timer = pollTimer(setSpy);

    await act(async () => {
      timer.call[0]();
    });

    expect(apiGet.mock.calls.length).toBe(before + 1);
    expect(apiGet).toHaveBeenLastCalledWith('/threads');
  });
});

describe('ThreadsPage — the thread detail', () => {
  it('fetches and renders the conversation when a row is clicked', async () => {
    routeApi();
    const user = userEvent.setup();

    render(<ThreadsPage />);
    await openFirstThread(user);

    expect(await screen.findByText(/worth 15 minutes next week/)).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/threads/t-1');
    expect(screen.getByText(/how about Thursday/)).toBeInTheDocument();
  });

  it('distinguishes what was sent from what came back', async () => {
    routeApi();
    const user = userEvent.setup();

    const { container } = render(<ThreadsPage />);
    await openFirstThread(user);
    await screen.findByText(/worth 15 minutes next week/);

    const sheets = container.querySelectorAll('.msg-sheet');
    expect(sheets).toHaveLength(2);
    expect(sheets[0]).toHaveClass('from-self');
    expect(sheets[1]).not.toHaveClass('from-self');
    // From, to and date are all on the page, in mono.
    expect(screen.getByText('ana@desk.com')).toBeInTheDocument();
    expect(screen.getByText('To sam@corp.com')).toBeInTheDocument();
  });

  it('renders a reply body as text, never as markup', async () => {
    const hostile = '<img src=x onerror="boom()"> hello there';
    routeApi({
      detail: {
        threadId: 't-1',
        messages: [DETAIL.messages[0], { ...DETAIL.messages[1], body: hostile }]
      }
    });
    const user = userEvent.setup();

    const { container } = render(<ThreadsPage />);
    await openFirstThread(user);

    // Interpolated, not injected: no dangerouslySetInnerHTML anywhere on this path.
    const shown = await screen.findByText(/<img src=x/);
    expect(shown).toHaveClass('msg-body');
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders a calm not-found when the thread is not one of theirs', async () => {
    const err = new Error('Thread not found');
    err.status = 404;
    routeApi({ detailError: err });
    const user = userEvent.setup();

    const { container } = render(<ThreadsPage />);
    await openFirstThread(user);

    expect(await screen.findByText(/isn't in your register/i)).toBeInTheDocument();
    expect(screen.getByText('Not found')).toBeInTheDocument();
    // Not theirs is not a fault: no alarm, no red error line.
    expect(container.querySelector('.msg.error')).toBeNull();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the server message for a real detail failure', async () => {
    const err = new Error('Gmail is not connected');
    err.status = 400;
    routeApi({ detailError: err });
    const user = userEvent.setup();

    render(<ThreadsPage />);
    await openFirstThread(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('Gmail is not connected');
  });

  it('goes back to the register from the detail', async () => {
    routeApi();
    const user = userEvent.setup();

    render(<ThreadsPage />);
    await openFirstThread(user);
    await screen.findByText(/worth 15 minutes next week/);

    await user.click(screen.getByRole('button', { name: /back to the register/i }));

    expect(await screen.findByText('the pricing question')).toBeInTheDocument();
    expect(screen.queryByText(/worth 15 minutes next week/)).not.toBeInTheDocument();
  });
});
