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

const REGENERATE = { name: /regenerate/i };
const BUILD = { name: 'Build my voice profile' };

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

// Counts only — the shape GET /api/voice/corpus-summary returns in production.
const corpusSummary = {
  messageCount: 42,
  totalCleanedChars: 61840,
  suspectCount: 3,
  overCharBudget: false,
  cappedAt: 100
};

const profileRow = {
  id: 'vp-1',
  source_email_count: 42,
  version: 2,
  profile_json: {
    tone: 'direct and warm',
    formality_1to10: 4,
    greeting_styles: ['hey', 'hi'],
    signoff_styles: ['cheers'],
    sentence_starters: ['just wanted to', 'quick one —'],
    transition_words: ['anyway', 'so'],
    typical_length_words: { min: 40, median: 90, max: 160 },
    contractions: 'always',
    emoji_usage: 'never uses emoji',
    how_they_ask: 'one ask per email — "worth 15 minutes next week?"',
    signature_phrases: ['happy to jump on a call'],
    never_does: ["never says 'I hope this finds you well'", 'never uses semicolons']
  }
};

/** GET /voice resolves with a profile; everything else 404s. */
function mockReady(profile) {
  apiGet.mockImplementation((path) =>
    path === '/voice' ? Promise.resolve({ profile }) : Promise.reject(apiError('Not found', 404))
  );
}

beforeEach(() => {
  setUrl('');
  apiGet.mockImplementation((path) => {
    if (path === '/voice/corpus-summary') return Promise.resolve(corpusSummary);
    return Promise.reject(
      apiError(
        String(path).startsWith('/dev/ingest-preview') ? 'Not found' : 'No voice profile yet',
        404
      )
    );
  });
  apiPost.mockReset();
  navigateTo.mockReset();
});

describe('OnboardingPage — disconnected', () => {
  it('renders the Connect Gmail button when GET /voice 404s', async () => {
    render(<OnboardingPage session={session} />);

    expect(await screen.findByRole('button', { name: 'Connect Gmail' })).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/voice');
    // The read-only promise is made on the screen that asks for the mailbox.
    expect(screen.getByText('Read-only')).toBeInTheDocument();
    expect(screen.getByText('Never stored')).toBeInTheDocument();
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

    expect(await screen.findByRole('button', BUILD)).toBeInTheDocument();
    expect(screen.getByText('Emails taken down')).toBeInTheDocument();
    // The whole point: the corpus is inspectable before anything is built from it.
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('renders the stat strip from /voice/corpus-summary', async () => {
    setUrl('?connected=1');

    const { container } = render(<OnboardingPage session={session} />);

    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/voice/corpus-summary'));

    const strip = await waitFor(() => {
      const found = container.querySelector('.statstrip');
      expect(found.textContent).toContain('42');
      return found;
    });

    expect(strip.textContent).toContain('Characters cleaned');
    // Locale-tolerant: the thousands separator is the browser's business.
    expect(strip.textContent).toMatch(/61.?840/);
    // A flagged count above zero goes red.
    expect(container.querySelector('.stat-value.hot').textContent).toBe('3 of 42');
  });

  it('renders no email bodies in the ingest stage when the dev preview is absent', async () => {
    setUrl('?connected=1');

    const { container } = render(<OnboardingPage session={session} />);

    await screen.findByRole('button', BUILD);
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/dev/ingest-preview'));

    // Production shape: counts only. Nothing that could carry message text renders.
    expect(screen.queryByText('Ingestion preview')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show body' })).not.toBeInTheDocument();
    expect(container.querySelector('.corpus')).toBeNull();
    expect(container.querySelector('.body-text')).toBeNull();
    expect(container.querySelector('.statstrip')).not.toBeNull();
  });

  it('posts /voice/generate and shows the building state on click', async () => {
    setUrl('?connected=1');
    const pending = deferred();
    apiPost.mockReturnValue(pending.promise);
    const user = userEvent.setup();

    render(<OnboardingPage session={session} />);
    await user.click(await screen.findByRole('button', BUILD));

    expect(apiPost).toHaveBeenCalledWith('/voice/generate');
    expect(screen.getByRole('button', { name: 'Taking down your voice…' })).toBeInTheDocument();
  });

  it('disables the build button while the request is in flight', async () => {
    setUrl('?connected=1');
    const pending = deferred();
    apiPost.mockReturnValue(pending.promise);
    const user = userEvent.setup();

    render(<OnboardingPage session={session} />);
    const button = await screen.findByRole('button', BUILD);
    await user.click(button);

    expect(button).toBeDisabled();
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it('renders the profile summary once the build resolves', async () => {
    setUrl('?connected=1');
    apiPost.mockResolvedValue({ profile: profileRow });
    const user = userEvent.setup();

    render(<OnboardingPage session={session} />);
    await user.click(await screen.findByRole('button', BUILD));

    expect(await screen.findByRole('button', REGENERATE)).toBeInTheDocument();
    expect(screen.getByText('direct and warm')).toBeInTheDocument();
  });
});

describe('OnboardingPage — ready', () => {
  it('renders the dossier including never_does entries', async () => {
    mockReady(profileRow);

    render(<OnboardingPage session={session} />);

    expect(await screen.findByText('direct and warm')).toBeInTheDocument();
    expect(screen.getByText('4/10 · casual')).toBeInTheDocument();
    expect(screen.getByText('v2 · 42 emails')).toBeInTheDocument();
    expect(screen.getByText('Struck from every draft — your anti-slop filter')).toBeInTheDocument();
    expect(screen.getByText("never says 'I hope this finds you well'")).toBeInTheDocument();
    expect(screen.getByText('never uses semicolons')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByRole('button', REGENERATE)).toBeInTheDocument();
  });

  it('renders the verbatim clipping lists, the pull-quote and emoji usage', async () => {
    mockReady(profileRow);

    const { container } = render(<OnboardingPage session={session} />);

    expect(await screen.findByText('Greetings you use')).toBeInTheDocument();
    expect(screen.getByText('hey')).toBeInTheDocument();

    expect(screen.getByText('Sentence starters')).toBeInTheDocument();
    expect(screen.getByText('just wanted to')).toBeInTheDocument();

    expect(screen.getByText('Transition words')).toBeInTheDocument();
    expect(screen.getByText('anyway')).toBeInTheDocument();

    // Emoji is its own ledger row, not folded into another trait.
    expect(screen.getByText('Emoji')).toBeInTheDocument();
    expect(screen.getByText('never uses emoji')).toBeInTheDocument();

    expect(container.querySelector('.pullquote p').textContent).toContain(
      'worth 15 minutes next week?'
    );
  });

  it('does not crash on a malformed or partial profile_json', async () => {
    mockReady({
      id: 'vp-2',
      profile_json: {
        tone: null,
        greeting_styles: 'not-an-array',
        typical_length_words: 5,
        formality_1to10: { weird: true },
        never_does: [null, 'never uses semicolons', 12]
      }
    });

    const { container } = render(<OnboardingPage session={session} />);

    expect(await screen.findByText('never uses semicolons')).toBeInTheDocument();
    expect(screen.queryByText('not-an-array')).not.toBeInTheDocument();
    // Nothing usable for the meter or the length line, so neither is drawn.
    expect(container.querySelector('.meter')).toBeNull();
    expect(container.querySelector('.spec-length')).toBeNull();
    expect(screen.getByText('built from your sent mail')).toBeInTheDocument();
    expect(screen.getByRole('button', REGENERATE)).toBeInTheDocument();
  });

  it('renders a null profile_json without crashing', async () => {
    mockReady({ id: 'vp-3', profile_json: null });

    render(<OnboardingPage session={session} />);

    expect(await screen.findByText('Specification')).toBeInTheDocument();
    expect(screen.getByRole('button', REGENERATE)).toBeInTheDocument();
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
    await user.click(await screen.findByRole('button', BUILD));

    expect(
      await screen.findByText('No sent emails found in this Gmail account')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', BUILD)).toBeEnabled();
  });
});
