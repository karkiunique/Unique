import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { signUp, signInWithPassword } = vi.hoisted(() => ({
  signUp: vi.fn(),
  signInWithPassword: vi.fn()
}));

// Auth is the only thing the browser talks to Supabase for; nothing real in tests.
vi.mock('../src/lib/supabase.js', () => ({
  isSupabaseConfigured: () => true,
  getSupabase: () => ({ auth: { signUp, signInWithPassword } }),
  getAccessToken: async () => null
}));

const { default: AuthPage } = await import('../src/pages/AuthPage.jsx');

const EMAIL = 'ana@corp.com';
const PASSWORD = 'correct-horse';
// The sign-off name (CLAUDE.md, Decisions 2026-08-13): required at signup, and
// the only field signup gained.
const FULL_NAME = 'Ana Ruiz';

async function fillCredentials(user) {
  await user.type(screen.getByLabelText('Email address'), EMAIL);
  await user.type(screen.getByLabelText('Password'), PASSWORD);
}

async function openSignup(user) {
  await user.click(screen.getByRole('button', { name: /No account yet/ }));
}

beforeEach(() => {
  signUp.mockReset();
  signInWithPassword.mockReset();
  signUp.mockResolvedValue({ data: { session: { user: { email: EMAIL } } }, error: null });
  signInWithPassword.mockResolvedValue({
    data: { session: { user: { email: EMAIL } } },
    error: null
  });
});

describe('AuthPage', () => {
  it('renders the editorial hero and the sign-in slip', () => {
    render(<AuthPage />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Cold emails that sound like you wrote them.'
    );
    expect(screen.getByText('No. 001 · The voice issue')).toBeInTheDocument();
    expect(screen.getByText('Read-only · Never stored · Human-confirmed')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enter' })).toBeInTheDocument();
  });

  it('toggles between sign in and sign up', async () => {
    const user = userEvent.setup();

    render(<AuthPage />);
    await user.click(screen.getByRole('button', { name: /No account yet/ }));

    expect(screen.getByRole('heading', { name: 'Sign up' })).toBeInTheDocument();
    expect(screen.getByText('Open an account')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Already have an account/ }));

    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enter' })).toBeInTheDocument();
  });

  it('signs in through Supabase in login mode', async () => {
    const user = userEvent.setup();

    render(<AuthPage />);
    await fillCredentials(user);
    await user.click(screen.getByRole('button', { name: 'Enter' }));

    expect(signInWithPassword).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD });
    expect(signUp).not.toHaveBeenCalled();
  });

  /**
   * The name travels as auth signup METADATA. The migration 006 trigger reads
   * raw_user_meta_data->>'full_name' and puts it on the profile row, so there is
   * no second write to lose — and without it a new user gets no sign-off
   * enforcement at all.
   */
  it('signs up through Supabase with the full name as auth metadata', async () => {
    const user = userEvent.setup();

    render(<AuthPage />);
    await openSignup(user);
    await user.type(screen.getByLabelText('Full name'), FULL_NAME);
    await fillCredentials(user);
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(signUp).toHaveBeenCalledWith({
      email: EMAIL,
      password: PASSWORD,
      options: { data: { full_name: FULL_NAME } }
    });
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it('asks for the full name on signup only, never on sign-in', async () => {
    const user = userEvent.setup();

    render(<AuthPage />);
    expect(screen.queryByLabelText('Full name')).not.toBeInTheDocument();

    await openSignup(user);
    expect(screen.getByLabelText('Full name')).toBeInTheDocument();

    // Signup gained this field and nothing else: no company, no role.
    expect(screen.queryByLabelText(/company/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/role/i)).not.toBeInTheDocument();
  });

  it('refuses to sign up without a name', async () => {
    const user = userEvent.setup();

    render(<AuthPage />);
    await openSignup(user);
    // Spaces, so the browser's own `required` check passes and OURS is what runs.
    await user.type(screen.getByLabelText('Full name'), '   ');
    await fillCredentials(user);
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Enter your full name.');
    expect(signUp).not.toHaveBeenCalled();
  });

  it('surfaces an auth error', async () => {
    signInWithPassword.mockResolvedValue({
      data: null,
      error: { message: 'Invalid login credentials' }
    });
    const user = userEvent.setup();

    render(<AuthPage />);
    await fillCredentials(user);
    await user.click(screen.getByRole('button', { name: 'Enter' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid login credentials');
  });

  it('disables the submit button while the request is in flight', async () => {
    let release;
    signInWithPassword.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ data: { session: {} }, error: null });
        })
    );
    const user = userEvent.setup();

    render(<AuthPage />);
    await fillCredentials(user);
    await user.click(screen.getByRole('button', { name: 'Enter' }));

    const busyButton = await screen.findByRole('button', { name: 'Working…' });
    expect(busyButton).toBeDisabled();

    release();
    expect(await screen.findByRole('button', { name: 'Enter' })).toBeEnabled();
  });
});
