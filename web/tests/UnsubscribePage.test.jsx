import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));

// No real network in tests.
vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: apiPost, patch: vi.fn() },
  apiFetch: vi.fn()
}));

const { default: UnsubscribePage } = await import('../src/pages/UnsubscribePage.jsx');

const TOKEN = 'eyJ1IjoiYWJjIn0.c2ln';
const RAW_SERVER_ERROR = 'Invalid or expired unsubscribe link';

function apiError(message, status) {
  const err = new Error(message);
  err.status = status;
  err.stack = 'Error: at Object.<anonymous> (/server/src/routes/unsubscribe.js:31:5)';
  return err;
}

function atUnsubscribePath(token = TOKEN) {
  window.history.pushState({}, '', `/u/${token}`);
}

/** Nothing on this page may look like the app: no masthead, no nav, no sign-in. */
function expectsNoAppChrome(container) {
  expect(container.querySelector('.masthead')).toBeNull();
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  expect(container.textContent).not.toMatch(/sign in|log in/i);
}

beforeEach(() => {
  apiPost.mockReset();
  apiPost.mockResolvedValue({ status: 'unsubscribed' });
  atUnsubscribePath();
});

afterEach(() => {
  window.history.pushState({}, '', '/');
});

describe('UnsubscribePage', () => {
  it('posts the token read off the path, on mount', async () => {
    render(<UnsubscribePage />);

    expect(await screen.findByText('You are off this list.')).toBeInTheDocument();
    expect(apiPost).toHaveBeenCalledWith(`/unsubscribe/${TOKEN}`, undefined, { auth: false });
  });

  it("renders the removed state for { status: 'unsubscribed' }", async () => {
    apiPost.mockResolvedValue({ status: 'unsubscribed' });

    const { container } = render(<UnsubscribePage />);

    expect(await screen.findByText('Removed.')).toBeInTheDocument();
    expect(
      screen.getByText(/You will not be contacted again from this sender\./)
    ).toBeInTheDocument();
    expectsNoAppChrome(container);
  });

  it("renders the already-removed state for { status: 'already' } and does not call it an error", async () => {
    apiPost.mockResolvedValue({ status: 'already' });

    const { container } = render(<UnsubscribePage />);

    expect(await screen.findByText('You were already off this list.')).toBeInTheDocument();
    expect(screen.getByText('No further action is needed')).toBeInTheDocument();

    // Calm, not a failure: no alert, no error vocabulary, no retry demand.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/error|failed|sorry|try again/i);
    expectsNoAppChrome(container);
  });

  it('renders a calm invalid state on a 400, with no raw error detail', async () => {
    apiPost.mockRejectedValue(apiError(RAW_SERVER_ERROR, 400));

    const { container } = render(<UnsubscribePage />);

    expect(await screen.findByText('This link is no longer valid.')).toBeInTheDocument();
    expect(screen.getByText(/reply to the email directly/)).toBeInTheDocument();

    // No server message, no stack, no blame.
    expect(container.textContent).not.toContain(RAW_SERVER_ERROR);
    expect(container.textContent).not.toContain('unsubscribe.js');
    expect(container.textContent).not.toMatch(/error:|stack|400/i);
    expectsNoAppChrome(container);
  });

  it('renders the invalid state when the path carries no token, without calling the API', async () => {
    window.history.pushState({}, '', '/u/');

    const { container } = render(<UnsubscribePage />);

    expect(await screen.findByText('This link is no longer valid.')).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
    expectsNoAppChrome(container);
  });
});
