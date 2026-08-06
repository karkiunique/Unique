import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));

// No real network in tests.
vi.mock('../src/lib/api.js', () => ({
  api: { get: apiGet, post: vi.fn(), patch: vi.fn() },
  apiFetch: vi.fn()
}));

const { default: ThreadsPage } = await import('../src/pages/ThreadsPage.jsx');

const POLL_MS = 30000;

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

/** The poll timer, not whatever waitFor happens to schedule. */
function pollTimer(spy) {
  const index = spy.mock.calls.findIndex(([, delay]) => delay === POLL_MS);
  return { index, call: spy.mock.calls[index], id: spy.mock.results[index]?.value };
}

beforeEach(() => {
  apiGet.mockReset();
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
});
