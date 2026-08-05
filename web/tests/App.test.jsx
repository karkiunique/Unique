import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { apiGet, getSession, onAuthStateChange, unsubscribe } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  unsubscribe: vi.fn()
}));

vi.mock('../src/lib/api.js', () => ({
  api: { get: apiGet, post: vi.fn(), patch: vi.fn() },
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
  onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe } } });
});

describe('App', () => {
  it('renders AuthPage when there is no session', async () => {
    getSession.mockResolvedValue({ data: { session: null } });

    render(<App />);

    expect(await screen.findByText('Sign in to continue')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('renders OnboardingPage when there is a session', async () => {
    getSession.mockResolvedValue({
      data: { session: { user: { email: 'dev@example.com' } } }
    });

    render(<App />);

    expect(await screen.findByRole('button', { name: 'Connect Gmail' })).toBeInTheDocument();
    expect(screen.getByText('Signed in as dev@example.com')).toBeInTheDocument();
  });
});
