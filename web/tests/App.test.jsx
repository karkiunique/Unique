import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { apiGet, apiPost, getSession, onAuthStateChange, unsubscribe } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  unsubscribe: vi.fn()
}));

vi.mock('../src/lib/api.js', () => ({
  api: { get: apiGet, post: apiPost, patch: vi.fn() },
  apiFetch: vi.fn()
}));

vi.mock('../src/lib/navigate.js', () => ({
  navigateTo: vi.fn(),
  getQueryParam: () => null
}));

vi.mock('../src/lib/supabase.js', () => ({
  isSupabaseConfigured: () => true,
  getSupabase: () => ({
    auth: {
      getSession,
      onAuthStateChange,
      signOut: vi.fn(),
      signUp: vi.fn(),
      signInWithPassword: vi.fn()
    }
  }),
  getAccessToken: async () => 'test-token'
}));

const { default: App } = await import('../src/App.jsx');

function apiError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

beforeEach(() => {
  apiGet.mockImplementation(() => Promise.reject(apiError('No voice profile yet', 404)));
  apiPost.mockResolvedValue({ status: 'unsubscribed' });
  onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe } } });
  getSession.mockReset();
  window.history.pushState({}, '', '/');
});

afterEach(() => {
  window.history.pushState({}, '', '/');
});

describe('App', () => {
  // Decisions, 2026-08-15: `/` is the front door and must not be a password box.
  it('renders LandingPage at / when there is no session, and never AuthPage', async () => {
    getSession.mockResolvedValue({ data: { session: null } });

    render(<App />);

    expect(await screen.findByRole('heading', { name: /We make outreach/ })).toBeInTheDocument();
    expect(screen.queryByText('Return to your desk')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enter' })).not.toBeInTheDocument();
  });

  it('renders AuthPage at /signin when there is no session', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    window.history.pushState({}, '', '/signin');

    render(<App />);

    expect(await screen.findByText('Return to your desk')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enter' })).toBeInTheDocument();
  });

  // Someone typing an app path is reaching for the app, not for the brochure.
  it('renders AuthPage on any other signed-out path, not the landing page', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    window.history.pushState({}, '', '/compose');

    render(<App />);

    expect(await screen.findByRole('button', { name: 'Enter' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /We make outreach/ })).not.toBeInTheDocument();
  });

  it('shows the app, not a login form, to a signed-in user who lands on /signin', async () => {
    getSession.mockResolvedValue({
      data: { session: { user: { email: 'dev@example.com' } } }
    });
    window.history.pushState({}, '', '/signin');

    render(<App />);

    expect(await screen.findByRole('button', { name: 'Connect Gmail' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enter' })).not.toBeInTheDocument();
  });

  it('renders OnboardingPage inside the shell when there is a session', async () => {
    getSession.mockResolvedValue({
      data: { session: { user: { email: 'dev@example.com' } } }
    });

    render(<App />);

    expect(await screen.findByRole('button', { name: 'Connect Gmail' })).toBeInTheDocument();
    expect(screen.getByText('Signed in as dev@example.com')).toBeInTheDocument();
    // The masthead names the desk this app belongs to.
    expect(screen.getAllByText('dev@example.com').length).toBeGreaterThan(0);
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Voice profile/ })).toBeInTheDocument();
  });

  it('renders UnsubscribePage on /u/<token> with no session, and never AuthPage', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    window.history.pushState({}, '', '/u/token-abc.sig');

    render(<App />);

    expect(await screen.findByText('You are off this list.')).toBeInTheDocument();
    expect(apiPost).toHaveBeenCalledWith('/unsubscribe/token-abc.sig', undefined, { auth: false });

    // The stranger following this link is not a user: no auth, no app chrome.
    expect(getSession).not.toHaveBeenCalled();
    expect(screen.queryByText('Return to your desk')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enter' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
});
