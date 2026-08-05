import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { apiGet, apiPost, navigateTo, signOut } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  navigateTo: vi.fn(),
  signOut: vi.fn()
}));

// No real network in tests.
vi.mock('../src/lib/api.js', () => ({
  api: { get: apiGet, post: apiPost, patch: vi.fn() },
  apiFetch: vi.fn()
}));

// navigateTo is stubbed so asserting on a redirect never actually navigates.
// getQueryParam keeps its real behaviour so history.replaceState drives the state machine.
vi.mock('../src/lib/navigate.js', () => ({
  navigateTo,
  getQueryParam: (name) => new URLSearchParams(window.location.search || '').get(name)
}));

vi.mock('../src/lib/supabase.js', () => ({
  isSupabaseConfigured: () => true,
  getSupabase: () => ({ auth: { signOut } }),
  getAccessToken: async () => 'test-token'
}));

const { default: OnboardingPage } = await import('../src/pages/OnboardingPage.jsx');

const session = { user: { email: 'dev@example.com' } };

function apiError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
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

function setUrl(search) {
  window.history.replaceState({}, '', `/onboarding${search}`);
}

const profileRow = {
  id: 'vp-1',
  source_email_count: 42,
  version: 2,
  profile_json: {
    tone: 'direct and warm',
    formality_1to10: 4,
    greeting_styles: ['hey', 'hi'],
    signoff_styles: ['cheers'],
    typical_length_words: { min: 40, median: 90, max: 160 },
    contractions: 'always',
    emoji_usage: 'never',
    signature_phrases: ['happy to jump on a call'],
    never_does: ["never says 'I hope this finds you well'", 'never uses semicolons']
  }
};

beforeEach(() => {
  setUrl('');
  apiGet.mockImplementation((path) =>
    Promise.reject(
      apiError(
        String(path).startsWith('/dev/ingest-preview') ? 'Not found' : 'No voice profile yet',
        404
      )
    )
  );
  apiPost.mockReset();
  navigateTo.mockReset();
});

describe('OnboardingPage — disconnected', () => {
  it('renders the Connect Gmail button when GET /voice 404s', async () => {
    render(<OnboardingPage session={session} />);

    expect(await screen.findByRole('button', { name: 'Connect Gmail' })).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/voice');
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
  });

  it('posts /gmail/connect and navigates to the returned consent url', async () => {
    const consentUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x';
    apiPost.mockResolvedValue({ url: consentUrl });
    const user = userEvent.setup();

    render(<OnboardingPage session={session} />);
    await user.click(await screen.findByRole('button', { name: 'Connect Gmail' }));

    expect(apiPost).toHaveBeenCalledWith('/gmail/connect');
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith(consentUrl));
  });
});

describe('OnboardingPage — connected', () => {
  it('shows the connected state and does NOT auto-generate the profile', async () => {
    setUrl('?connected=1');

    render(<OnboardingPage session={session} />);

    expect(await screen.findByRole('button', { name: 'Build my voice profile' })).toBeInTheDocument();
    expect(screen.getByText('Gmail connected')).toBeInTheDocument();
    // The whole point: the corpus is inspectable before anything is built from it.
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('posts /voice/generate and shows the building state on click', async () => {
    setUrl('?connected=1');
    const pending = deferred();
    apiPost.mockReturnValue(pending.promise);
    const user = userEvent.setup();

    render(<OnboardingPage session={session} />);
    await user.click(await screen.findByRole('button', { name: 'Build my voice profile' }));

    expect(apiPost).toHaveBeenCalledWith('/voice/generate');
    expect(screen.getByText(/Building your voice profile/i)).toBeInTheDocument();
  });

  it('disables the build button while the request is in flight', async () => {
    setUrl('?connected=1');
    const pending = deferred();
    apiPost.mockReturnValue(pending.promise);
    const user = userEvent.setup();

    render(<OnboardingPage session={session} />);
    const button = await screen.findByRole('button', { name: 'Build my voice profile' });
    await user.click(button);

    expect(button).toBeDisabled();
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it('renders the profile summary once the build resolves', async () => {
    setUrl('?connected=1');
    apiPost.mockResolvedValue({ profile: profileRow });
    const user = userEvent.setup();

    render(<OnboardingPage session={session} />);
    await user.click(await screen.findByRole('button', { name: 'Build my voice profile' }));

    expect(await screen.findByRole('button', { name: 'Regenerate' })).toBeInTheDocument();
    expect(screen.getByText('direct and warm')).toBeInTheDocument();
  });
});

describe('OnboardingPage — ready', () => {
  it('renders the profile summary including never_does entries', async () => {
    apiGet.mockImplementation((path) =>
      path === '/voice'
        ? Promise.resolve({ profile: profileRow })
        : Promise.reject(apiError('Not found', 404))
    );

    render(<OnboardingPage session={session} />);

    expect(await screen.findByText('Your voice profile')).toBeInTheDocument();
    expect(screen.getByText('direct and warm')).toBeInTheDocument();
    expect(screen.getByText('4 / 10')).toBeInTheDocument();
    expect(screen.getByText(/Built from 42 sent emails/)).toBeInTheDocument();
    expect(screen.getByText('Never does')).toBeInTheDocument();
    expect(screen.getByText("never says 'I hope this finds you well'")).toBeInTheDocument();
    expect(screen.getByText('never uses semicolons')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeInTheDocument();
  });

  it('does not crash on a malformed or partial profile_json', async () => {
    apiGet.mockImplementation((path) =>
      path === '/voice'
        ? Promise.resolve({
            profile: {
              id: 'vp-2',
              profile_json: {
                tone: null,
                greeting_styles: 'not-an-array',
                typical_length_words: 5,
                formality_1to10: { weird: true },
                never_does: [null, 'never uses semicolons', 12]
              }
            }
          })
        : Promise.reject(apiError('Not found', 404))
    );

    render(<OnboardingPage session={session} />);

    expect(await screen.findByText('Your voice profile')).toBeInTheDocument();
    expect(screen.getByText('never uses semicolons')).toBeInTheDocument();
    expect(screen.queryByText('not-an-array')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeInTheDocument();
  });

  it('renders a null profile_json without crashing', async () => {
    apiGet.mockImplementation((path) =>
      path === '/voice'
        ? Promise.resolve({ profile: { id: 'vp-3', profile_json: null } })
        : Promise.reject(apiError('Not found', 404))
    );

    render(<OnboardingPage session={session} />);

    expect(await screen.findByText('Your voice profile')).toBeInTheDocument();
  });
});

describe('OnboardingPage — errors', () => {
  it('renders the server message in an .error element with a retry', async () => {
    apiGet.mockImplementation(() =>
      Promise.reject(apiError('Could not load the voice profile', 500))
    );

    const { container } = render(<OnboardingPage session={session} />);

    expect(await screen.findByText('Could not load the voice profile')).toBeInTheDocument();
    expect(container.querySelector('.error')).toHaveTextContent('Could not load the voice profile');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('renders a failed build as an error and keeps the build button', async () => {
    setUrl('?connected=1');
    apiPost.mockRejectedValue(apiError('No sent emails found in this Gmail account', 400));
    const user = userEvent.setup();

    render(<OnboardingPage session={session} />);
    await user.click(await screen.findByRole('button', { name: 'Build my voice profile' }));

    expect(
      await screen.findByText('No sent emails found in this Gmail account')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Build my voice profile' })).toBeEnabled();
  });
});
