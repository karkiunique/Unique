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

async function fillCredentials(user) {
  await user.type(screen.getByLabelText('Email address'), EMAIL);
  await user.type(screen.getByLabelText('Password'), PASSWORD);
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
    expect(screen.getByText('No. 001 — The voice issue')).toBeInTheDocument();
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

  it('signs up through Supabase in signup mode', async () => {
    const user = userEvent.setup();

    render(<AuthPage />);
    await user.click(screen.getByRole('button', { name: /No account yet/ }));
    await fillCredentials(user);
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(signUp).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD });
    expect(signInWithPassword).not.toHaveBeenCalled();
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
