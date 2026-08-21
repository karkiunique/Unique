import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * The public landing page (Decisions, 2026-08-15).
 *
 * Two things matter most here and neither is cosmetic:
 *
 * 1. The page renders for a stranger. No session, no authed request, and — the
 *    part that is easy to regress — it still renders when the API is down, because
 *    the counter is decoration and the form is the point.
 * 2. The reply-rate figures are the INDUSTRY's, shown with their attribution. A
 *    change that quietly drops the label, or restores the unsourced 41%, turns a
 *    benchmark into a claim about us. The test asserts on both numbers and on the
 *    label, so removing the label fails.
 */

const { apiFetch, navigateTo, reloadPage } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  navigateTo: vi.fn(),
  reloadPage: vi.fn()
}));

vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  apiFetch
}));

vi.mock('../src/lib/navigate.js', () => ({
  navigateTo,
  reloadPage,
  getQueryParam: () => null
}));

const { default: LandingPage } = await import('../src/pages/LandingPage.jsx');

beforeEach(() => {
  apiFetch.mockReset();
  navigateTo.mockReset();
  reloadPage.mockReset();
  apiFetch.mockImplementation((path) =>
    path === '/waitlist/count' ? Promise.resolve({ count: 88 }) : Promise.resolve({})
  );
});

describe('LandingPage', () => {
  it('renders the hero, the five steps and the waitlist with no session', async () => {
    render(<LandingPage />);

    expect(screen.getByRole('heading', { name: /We make outreach/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Connect your Gmail/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Track replies/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reserve my seat/ })).toBeInTheDocument();

    // Every request this page makes is unauthenticated.
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    for (const [, options] of apiFetch.mock.calls) {
      expect(options).toMatchObject({ auth: false });
    }
  });

  it('shows the benchmark figures WITH their attribution, and never 41%', () => {
    render(<LandingPage />);

    expect(screen.getByText('reply 3%')).toBeInTheDocument();
    expect(screen.getByText('reply 11%')).toBeInTheDocument();
    expect(screen.getByText(/Industry benchmarks/i)).toBeInTheDocument();
    // The handoff's unsourced number. It must not come back.
    expect(screen.queryByText(/41%/)).not.toBeInTheDocument();
  });

  it('reloads the page from the masthead wordmark, and does not navigate away', async () => {
    render(<LandingPage />);

    const wordmark = screen.getByRole('button', { name: /Reload the Unique home page/i });
    await userEvent.click(wordmark);

    expect(reloadPage).toHaveBeenCalledTimes(1);
    // A reload, not a route change: /signin must not be reachable by accident
    // from the one control a visitor is most likely to click first.
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it('sends the visitor to /signin only when they ask for it', async () => {
    render(<LandingPage />);

    expect(navigateTo).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(navigateTo).toHaveBeenCalledWith('/signin');
  });

  it('shows the live count in both counters once it arrives', async () => {
    apiFetch.mockResolvedValue({ count: 137 });

    render(<LandingPage />);

    // Hero and waitlist block read from one piece of state, so they can never
    // disagree — which is the whole reason the count is not tracked twice.
    expect(await screen.findAllByText('137')).toHaveLength(2);
  });

  it('still renders when the API is unreachable, showing no number at all', async () => {
    apiFetch.mockRejectedValue(new Error('Failed to fetch'));

    render(<LandingPage />);

    expect(screen.getByRole('button', { name: /Reserve my seat/ })).toBeInTheDocument();
    // No invented figure. A number the page could not have known is worse than none.
    await waitFor(() => expect(screen.getAllByText('···')).toHaveLength(2));
    expect(screen.queryByText('88')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('stamps the confirmation with the seat the SERVER issued, not the local count', async () => {
    apiFetch.mockImplementation((path) =>
      path === '/waitlist/count'
        ? Promise.resolve({ count: 88 })
        : Promise.resolve({ seat: 104, count: 104 })
    );

    render(<LandingPage />);

    await userEvent.type(screen.getByLabelText('Email address'), 'sam@acme.com');
    await userEvent.click(screen.getByRole('button', { name: /Reserve my seat/ }));

    expect(await screen.findByText(/You’re on the list/)).toBeInTheDocument();
    expect(screen.getByText('No. 104')).toBeInTheDocument();
    expect(screen.getByText('sam@acme.com')).toBeInTheDocument();

    expect(apiFetch).toHaveBeenCalledWith('/waitlist', {
      method: 'POST',
      body: { email: 'sam@acme.com' },
      auth: false
    });

    // The hero counter moves with it.
    expect(screen.getByText('104')).toBeInTheDocument();
  });

  /**
   * The counter is monotonic. A returning member re-submitting is answered with
   * the list's count, not their own seat — but the page must not depend on the
   * server getting that right, because a counter that ticks DOWN in front of a
   * visitor reads as broken however it got there.
   */
  it('never lets the counter go backwards when a join answers low', async () => {
    apiFetch.mockImplementation((path) =>
      path === '/waitlist/count'
        ? Promise.resolve({ count: 137 })
        : // An existing member's own seat, lower than the live count.
          Promise.resolve({ seat: 90, count: 90 })
    );

    render(<LandingPage />);
    await waitFor(() => expect(screen.getAllByText('137').length).toBeGreaterThan(0));

    await userEvent.type(screen.getByLabelText('Email address'), 'sam@acme.com');
    await userEvent.click(screen.getByRole('button', { name: /Reserve my seat/ }));

    // They are told their real seat...
    expect(await screen.findByText('No. 90')).toBeInTheDocument();
    // ...and the counter held at 137 rather than counting itself down.
    expect(screen.getByText('137')).toBeInTheDocument();
    expect(screen.queryByText('90')).not.toBeInTheDocument();
  });

  it('does not let a late count fetch overwrite a completed join', async () => {
    let resolveCount;
    apiFetch.mockImplementation((path) => {
      if (path === '/waitlist/count') {
        // Still in flight when the join lands — it read the list BEFORE the join.
        return new Promise((resolve) => {
          resolveCount = resolve;
        });
      }
      return Promise.resolve({ seat: 138, count: 138 });
    });

    render(<LandingPage />);

    await userEvent.type(screen.getByLabelText('Email address'), 'sam@acme.com');
    await userEvent.click(screen.getByRole('button', { name: /Reserve my seat/ }));
    expect(await screen.findByText('No. 138')).toBeInTheDocument();

    resolveCount({ count: 137 });

    await waitFor(() => expect(screen.getByText('138')).toBeInTheDocument());
    expect(screen.queryByText('137')).not.toBeInTheDocument();
  });

  it('shows the server’s own message when the server answered', async () => {
    apiFetch.mockImplementation((path) => {
      if (path === '/waitlist/count') return Promise.resolve({ count: 88 });
      // A real response, so the message is ours and safe to surface verbatim.
      const err = new Error('Too many requests, please slow down');
      err.status = 429;
      return Promise.reject(err);
    });

    render(<LandingPage />);

    await userEvent.type(screen.getByLabelText('Email address'), 'sam@acme.com');
    await userEvent.click(screen.getByRole('button', { name: /Reserve my seat/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests');
    expect(screen.queryByText(/You’re on the list/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reserve my seat/ })).toBeInTheDocument();
  });

  /**
   * When the API is unreachable, fetch rejects with a TypeError reading "Failed to
   * fetch". That is a developer string and must never reach a visitor — it tells
   * them nothing they can act on and makes the product look broken for a reason
   * that is ours, not theirs.
   */
  it('never shows the raw "Failed to fetch" when the server is unreachable', async () => {
    apiFetch.mockImplementation((path) => {
      if (path === '/waitlist/count') return Promise.resolve({ count: 88 });
      // No `status`: the request never landed. This is exactly what a stopped
      // server looks like from the browser.
      return Promise.reject(new TypeError('Failed to fetch'));
    });

    render(<LandingPage />);

    await userEvent.type(screen.getByLabelText('Email address'), 'sam@acme.com');
    await userEvent.click(screen.getByRole('button', { name: /Reserve my seat/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not reach the waitlist');
    expect(alert).not.toHaveTextContent(/failed to fetch/i);
    expect(screen.queryByText(/You’re on the list/)).not.toBeInTheDocument();
  });

  it('refuses an obviously malformed address without calling the API', async () => {
    render(<LandingPage />);

    await userEvent.type(screen.getByLabelText('Email address'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: /Reserve my seat/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('valid email address');
    expect(apiFetch).not.toHaveBeenCalledWith('/waitlist', expect.anything());
  });
});

/**
 * THE COUNTER MUST NOT SECOND-GUESS THE SERVER.
 *
 * There used to be a `count >= 88` floor here, left over from when the server added
 * the same 88 as an offset. Migration 010 moved the baseline into the table, the
 * server began returning the raw row count, and the floor silently discarded every
 * real answer below it — the page showed 88 while the API plainly returned 6.
 */
describe('the counter trusts the server', () => {
  it('shows a real count below the old floor instead of overriding it', async () => {
    apiFetch.mockResolvedValue({ count: 6 });

    render(<LandingPage />);

    expect(await screen.findAllByText('6')).toHaveLength(2);
    expect(screen.queryByText('88')).not.toBeInTheDocument();
  });

  it('shows zero rather than inventing a number', async () => {
    apiFetch.mockResolvedValue({ count: 0 });

    render(<LandingPage />);

    await waitFor(() => expect(screen.getAllByText('0')).toHaveLength(2));
  });

  /**
   * THE FLASH. Rendering a placeholder NUMBER and then correcting it is a clearer
   * tell that the figure is fabricated than any wrong number would be: it shows the
   * page had an opinion before it had data. So there must be no number on the first
   * paint at all.
   */
  it('paints no number before the server answers', async () => {
    let resolveCount;
    apiFetch.mockImplementation(
      () => new Promise((resolve) => { resolveCount = resolve; })
    );

    render(<LandingPage />);

    // First paint: placeholder, and specifically not the old hardcoded 88.
    expect(screen.getAllByText('···')).toHaveLength(2);
    expect(screen.queryByText('88')).not.toBeInTheDocument();

    resolveCount({ count: 94 });

    await waitFor(() => expect(screen.getAllByText('94')).toHaveLength(2));
    expect(screen.queryByText('···')).not.toBeInTheDocument();
  });
});
