import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { apiPost, navigateTo } = vi.hoisted(() => ({ apiPost: vi.fn(), navigateTo: vi.fn() }));

// No real network in tests.
vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: apiPost, patch: vi.fn() },
  apiFetch: vi.fn()
}));

// Stubbed so asserting on the OAuth redirect never actually navigates.
vi.mock('../src/lib/navigate.js', () => ({
  navigateTo,
  getQueryParam: () => null
}));

const { default: ComposePage } = await import('../src/pages/ComposePage.jsx');

const TO = 'sam@corp.com';
const GOAL = 'ask for 15 minutes';
const SUBJECT = 'about the launch';
const BODY =
  "hey Sam\n\nworth 15 minutes next week?\n\nthanks,\nAna\n\nDon't want emails from me? [Unsubscribe](http://localhost:5173/u/abc.def)";

// The redesign renamed the fields and buttons; what they do is unchanged.
const TO_FIELD = 'To — email';
const GOAL_FIELD = 'What should it do?';
const DRAFT = { name: 'Draft in my voice' };
const REVIEW = { name: 'Review & send' };

function draft(overrides = {}) {
  return { subject: SUBJECT, body: BODY, fidelityScore: 92, violations: [], ...overrides };
}

/** Everything /send/generate needs, filled in. */
async function fillBrief(user) {
  await user.type(screen.getByLabelText(TO_FIELD), TO);
  await user.type(screen.getByLabelText(GOAL_FIELD), GOAL);
}

function callsTo(path) {
  return apiPost.mock.calls.filter(([called]) => called === path);
}

function sendCalls() {
  return callsTo('/send');
}

/**
 * Every path posted, in order. Asserted as a complete set rather than counted
 * per path, so ANY unexpected call fails — including a differently shaped
 * variant of /send such as a trailing slash, which Express routes to the same
 * handler and which a per-path count would wave straight through.
 */
function postedPaths() {
  return apiPost.mock.calls.map(([path]) => path);
}

function verifyCalls() {
  return callsTo('/send/verify-recipient');
}

/**
 * Two endpoints now answer on this page — drafting and the blur-triggered
 * recipient check — so responses are routed by path rather than by a single
 * blanket resolve.
 */
function routeApi({ verification, generated } = {}) {
  apiPost.mockImplementation(async (path) => {
    if (path === '/send/verify-recipient') {
      return verification ?? { status: 'ok', reasons: [], hasMx: true };
    }
    return generated ?? draft();
  });
}

beforeEach(() => {
  apiPost.mockReset();
  navigateTo.mockReset();
});

describe('ComposePage — generating', () => {
  it('calls /send/generate and fills the subject and body fields', async () => {
    apiPost.mockResolvedValue(draft());
    const user = userEvent.setup();

    render(<ComposePage />);
    await fillBrief(user);
    await user.type(screen.getByLabelText('Name'), 'Sam');
    await user.type(screen.getByLabelText('Company'), 'Corp');
    await user.click(screen.getByRole('button', DRAFT));

    expect(await screen.findByDisplayValue(SUBJECT)).toBeInTheDocument();
    expect(screen.getByLabelText('Email body')).toHaveValue(BODY);
    expect(apiPost).toHaveBeenCalledWith('/send/generate', {
      to: TO,
      recipientName: 'Sam',
      company: 'Corp',
      goal: GOAL
    });
  });

  it('renders a visible warning when the fidelity score is under 80', async () => {
    apiPost.mockResolvedValue(
      draft({ fidelityScore: 61, violations: ['greeting is not one they use'] })
    );
    const user = userEvent.setup();

    const { container } = render(<ComposePage />);
    await fillBrief(user);
    await user.click(screen.getByRole('button', DRAFT));

    // The score is on the page, flagged low, and says so in words.
    const score = await screen.findByText('61');
    expect(score.closest('.fidelity')).toHaveClass('low');
    expect(score.closest('.fidelity').textContent).toContain('/100');
    expect(container.querySelector('.error')).toHaveTextContent(/does not sound enough like you/i);
    expect(screen.getByText('read closely')).toBeInTheDocument();
    // Banned-phrase violations stay visible on the page, not hidden behind the badge.
    expect(screen.getByText('greeting is not one they use')).toBeInTheDocument();
  });

  it('does not warn when the fidelity score clears the bar', async () => {
    apiPost.mockResolvedValue(draft({ fidelityScore: 92 }));
    const user = userEvent.setup();

    const { container } = render(<ComposePage />);
    await fillBrief(user);
    await user.click(screen.getByRole('button', DRAFT));

    const score = await screen.findByText('92');
    expect(score.closest('.fidelity')).not.toHaveClass('low');
    expect(screen.getByText('sounds like you')).toBeInTheDocument();
    expect(container.querySelector('.error')).toBeNull();
  });

  it('renders the server error when drafting fails', async () => {
    const err = new Error('No voice profile yet — build one before generating');
    err.status = 400;
    apiPost.mockRejectedValue(err);
    const user = userEvent.setup();

    render(<ComposePage />);
    await fillBrief(user);
    await user.click(screen.getByRole('button', DRAFT));

    expect(
      await screen.findByText('No voice profile yet — build one before generating')
    ).toBeInTheDocument();
  });
});

describe('ComposePage — reaching the confirmation step', () => {
  it('disables "Review & send" until recipient, subject and body are filled', async () => {
    const user = userEvent.setup();

    render(<ComposePage />);
    const review = screen.getByRole('button', REVIEW);

    expect(review).toBeDisabled();

    await user.type(screen.getByLabelText(TO_FIELD), TO);
    expect(review).toBeDisabled();

    await user.type(screen.getByLabelText('Subject'), SUBJECT);
    expect(review).toBeDisabled();

    await user.type(screen.getByLabelText('Email body'), 'hey Sam');
    expect(review).toBeEnabled();
  });

  it('lets a hand-written email reach the confirm step without generating', async () => {
    const user = userEvent.setup();

    render(<ComposePage />);
    await user.type(screen.getByLabelText(TO_FIELD), TO);
    await user.type(screen.getByLabelText('Subject'), SUBJECT);
    await user.type(screen.getByLabelText('Email body'), 'hey Sam');
    await user.click(screen.getByRole('button', REVIEW));

    expect(await screen.findByText('Send this letter?')).toBeInTheDocument();
    // Generation is optional: nothing was drafted for us, and nothing was sent.
    // The blur on the To field fires the advisory recipient check and that is the
    // ONLY call this flow may make — anything else, under any path spelling, fails.
    expect(postedPaths()).toEqual(['/send/verify-recipient']);
  });

  it('never calls /send itself — only the confirm dialog does', async () => {
    apiPost.mockResolvedValue(draft());
    const user = userEvent.setup();

    render(<ComposePage />);
    await fillBrief(user);
    await user.click(screen.getByRole('button', DRAFT));
    await screen.findByDisplayValue(SUBJECT);
    await user.click(screen.getByRole('button', REVIEW));

    expect(await screen.findByText('Send this letter?')).toBeInTheDocument();
    // Opening the confirmation is not sending. Only the Send click posts /send,
    // so the complete set of calls this page made is the blur check and the draft
    // — no send, under any path spelling.
    expect(postedPaths()).toEqual(['/send/verify-recipient', '/send/generate']);
  });

  it('hands the confirm dialog exactly what is in the fields', async () => {
    const user = userEvent.setup();

    const { container } = render(<ComposePage />);
    await user.type(screen.getByLabelText(TO_FIELD), TO);
    await user.type(screen.getByLabelText('Subject'), SUBJECT);
    await user.type(screen.getByLabelText('Email body'), 'hey Sam');
    await user.click(screen.getByRole('button', REVIEW));

    await screen.findByText('Send this letter?');
    expect(container.querySelector('.confirm-to').textContent).toBe(TO);
    expect(container.querySelector('.confirm-subject').textContent).toBe(SUBJECT);
    expect(container.querySelector('.confirm-body').textContent).toBe('hey Sam');
  });

  it('Cancel on the confirm step returns to editing without sending', async () => {
    const user = userEvent.setup();

    render(<ComposePage />);
    await user.type(screen.getByLabelText(TO_FIELD), TO);
    await user.type(screen.getByLabelText('Subject'), SUBJECT);
    await user.type(screen.getByLabelText('Email body'), 'hey Sam');
    await user.click(screen.getByRole('button', REVIEW));
    await user.click(await screen.findByRole('button', { name: /keep editing/i }));

    expect(await screen.findByLabelText('Email body')).toHaveValue('hey Sam');
    expect(screen.queryByText('Send this letter?')).not.toBeInTheDocument();
    expect(sendCalls()).toHaveLength(0);
  });
});

describe('ComposePage — recovering a Gmail grant from the brief', () => {
  const RECONNECT = { name: 'Reconnect Gmail' };
  const CONSENT_URL = 'https://accounts.google.com/o/oauth2/v2/auth?scope=gmail.send';

  async function failDraftWith(err) {
    apiPost.mockImplementation(async (path) => {
      if (path === '/gmail/connect') return { url: CONSENT_URL };
      throw err;
    });

    const user = userEvent.setup();
    render(<ComposePage />);
    await fillBrief(user);
    await user.click(screen.getByRole('button', DRAFT));

    return user;
  }

  it('offers Reconnect Gmail when the server names that recovery', async () => {
    const err = new Error('Gmail needs re-approval for a new permission, please reconnect Gmail');
    err.status = 400;
    err.action = 'reconnect_gmail';

    const user = await failDraftWith(err);

    await user.click(await screen.findByRole('button', RECONNECT));

    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith(CONSENT_URL));
  });

  it('does NOT offer it for an ordinary failure', async () => {
    const err = new Error('No voice profile yet — build one before generating');
    err.status = 400;

    await failDraftWith(err);

    expect(await screen.findByText(err.message)).toBeInTheDocument();
    expect(screen.queryByRole('button', RECONNECT)).not.toBeInTheDocument();
  });
});

/**
 * 80 is a floor in the compose flow, not a warning (CLAUDE.md §3): one click
 * puts this in a stranger's inbox under the user's own name.
 *
 * The gate has to lift, though, or a user whose voice the model cannot reach is
 * stuck forever. Editing the words is the escape hatch: at that point they wrote
 * it, and the score describes text that no longer exists.
 */
describe('ComposePage — the fidelity floor', () => {
  const REGENERATE = { name: 'Regenerate' };

  async function generateScoring(score) {
    apiPost.mockResolvedValue(draft({ fidelityScore: score }));
    const user = userEvent.setup();
    const view = render(<ComposePage />);

    await fillBrief(user);
    await user.click(screen.getByRole('button', DRAFT));
    await screen.findByDisplayValue(SUBJECT);

    return { user, ...view };
  }

  it('will not let a draft under 80 reach the confirmation step', async () => {
    const { container } = await generateScoring(61);

    expect(screen.getByRole('button', REVIEW)).toBeDisabled();
    // Blocked, with the way out in the same box rather than three screens away.
    expect(screen.getByRole('button', REGENERATE)).toBeEnabled();
    expect(container.querySelector('.gate').textContent).toMatch(/floor of 80/i);
    expect(container.querySelector('.fidelity')).toHaveClass('low');
  });

  it('opens no confirmation dialog while blocked', async () => {
    const { user } = await generateScoring(61);

    await user.click(screen.getByRole('button', REVIEW));

    expect(screen.queryByText('Send this letter?')).not.toBeInTheDocument();
    expect(sendCalls()).toHaveLength(0);
  });

  it('lifts the gate the moment the user edits the body', async () => {
    const { user, container } = await generateScoring(61);

    expect(screen.getByRole('button', REVIEW)).toBeDisabled();

    await user.type(screen.getByLabelText('Email body'), ' one line of my own');

    // The words are theirs now — the product will not hold them behind a score.
    expect(screen.getByRole('button', REVIEW)).toBeEnabled();
    expect(container.querySelector('.gate')).toBeNull();
  });

  it('marks the score stale after an edit instead of showing a dead number', async () => {
    const { user, container } = await generateScoring(61);

    await user.type(screen.getByLabelText('Email body'), ' mine');

    const stamp = container.querySelector('.fidelity');

    expect(stamp).toHaveClass('stale');
    expect(stamp).not.toHaveClass('low');
    expect(stamp.textContent).toMatch(/stale/i);
  });

  it('lifts the gate on a subject edit too', async () => {
    const { user } = await generateScoring(61);

    await user.type(screen.getByLabelText('Subject'), '!');

    expect(screen.getByRole('button', REVIEW)).toBeEnabled();
  });

  it('re-arms the gate when a fresh draft also scores under 80', async () => {
    const { user, container } = await generateScoring(61);

    await user.type(screen.getByLabelText('Email body'), ' mine');
    expect(screen.getByRole('button', REVIEW)).toBeEnabled();

    await user.click(screen.getByRole('button', DRAFT));

    // New model words, new score: back under the floor, and blocked again.
    await waitFor(() => expect(container.querySelector('.gate')).not.toBeNull());
    expect(screen.getByRole('button', REVIEW)).toBeDisabled();
  });

  it('does not gate a score of exactly 80', async () => {
    const { container } = await generateScoring(80);

    expect(screen.getByRole('button', REVIEW)).toBeEnabled();
    expect(container.querySelector('.gate')).toBeNull();
    expect(screen.queryByRole('button', REGENERATE)).not.toBeInTheDocument();
  });

  it('never gates a hand-written letter — there is no score to gate on', async () => {
    const user = userEvent.setup();
    const { container } = render(<ComposePage />);

    await user.type(screen.getByLabelText(TO_FIELD), TO);
    await user.type(screen.getByLabelText('Subject'), SUBJECT);
    await user.type(screen.getByLabelText('Email body'), 'hey Sam\n\nthanks,\nAna');

    expect(screen.getByRole('button', REVIEW)).toBeEnabled();
    expect(container.querySelector('.gate')).toBeNull();
    expect(container.querySelector('.fidelity')).toBeNull();
  });
});

/**
 * The brief is where the user says what the letter has to do. A box that scrolls
 * after two lines quietly teaches them to say less, and less brief means a worse
 * draft.
 */
describe('ComposePage — the goal field grows with what is typed', () => {
  const CONTENT_BASE = 24;
  const PER_CHAR = 6;

  beforeEach(() => {
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        // A browser never reports a scrollHeight below the element's own height,
        // which is exactly why the hook has to reset the height before measuring.
        const content = CONTENT_BASE + this.value.length * PER_CHAR;
        return Math.max(content, parseFloat(this.style.height) || 0);
      }
    });
  });

  afterEach(() => {
    // Hands scrollHeight back to jsdom's own implementation on Element.
    delete HTMLTextAreaElement.prototype.scrollHeight;
  });

  it('grows as the brief gets longer and shrinks back when it is cleared', async () => {
    const user = userEvent.setup();
    render(<ComposePage />);
    const field = screen.getByLabelText(GOAL_FIELD);

    const empty = parseFloat(field.style.height);
    expect(empty).toBeGreaterThan(0);

    await user.type(field, 'ask for 15 minutes to walk through the demo');
    const grown = parseFloat(field.style.height);

    expect(grown).toBeGreaterThan(empty);

    await user.clear(field);

    // The common bug is a box that only ever gets taller. It must come back down.
    await waitFor(() => expect(parseFloat(field.style.height)).toBe(empty));
  });

  it('stops growing at the cap and scrolls beyond it', async () => {
    const user = userEvent.setup();
    render(<ComposePage />);
    const field = screen.getByLabelText(GOAL_FIELD);

    await user.type(field, 'a'.repeat(120));

    // Past the cap it scrolls rather than shoving the rest of the page away.
    expect(parseFloat(field.style.height)).toBe(240);
    expect(field.style.overflowY).toBe('auto');
  });
});

/**
 * The flag under the To field. It exists because the letter leaves the USER'S
 * own Gmail: a bounce costs them their personal sender reputation. It is loud,
 * and it is advisory — it never takes the decision away from them.
 */
describe('ComposePage — recipient verification', () => {
  async function typeAddressAndLeave(user, address = TO) {
    await user.type(screen.getByLabelText(TO_FIELD), address);
    await user.tab();
  }

  it('checks the address on blur, not on every keystroke', async () => {
    routeApi();
    const user = userEvent.setup();

    render(<ComposePage />);
    await user.type(screen.getByLabelText(TO_FIELD), TO);

    // Still focused: a half-typed address is not a domain.
    expect(verifyCalls()).toHaveLength(0);

    await user.tab();

    await waitFor(() => expect(verifyCalls()).toHaveLength(1));
    expect(verifyCalls()[0][1]).toEqual({ to: TO });
  });

  it('renders an understated tick when the domain accepts mail', async () => {
    routeApi({ verification: { status: 'ok', reasons: [], hasMx: true } });
    const user = userEvent.setup();

    const { container } = render(<ComposePage />);
    await typeAddressAndLeave(user);

    await waitFor(() => expect(container.querySelector('.verify-line.ok')).not.toBeNull());
    expect(container.querySelector('.verify-flag')).toBeNull();
  });

  it('renders a loud red flag for an address that cannot receive mail', async () => {
    routeApi({ verification: { status: 'invalid', reasons: ['no_mx'], hasMx: false } });
    const user = userEvent.setup();

    const { container } = render(<ComposePage />);
    await typeAddressAndLeave(user);

    const flag = await screen.findByRole('alert');

    expect(flag).toHaveClass('verify-flag');
    expect(flag).toHaveClass('invalid');
    expect(container.querySelector('.verify-flag.invalid')).not.toBeNull();
    expect(flag.textContent).toMatch(/will bounce/i);
    expect(flag.textContent).toMatch(/no mail server/i);
    // The point of the whole feature: the cost lands on the user's own account.
    expect(flag.textContent).toMatch(/your own gmail/i);
    expect(flag.textContent).toMatch(/sender reputation/i);
  });

  it('names the specific problem on a warn result', async () => {
    routeApi({ verification: { status: 'warn', reasons: ['role_address'], hasMx: true } });
    const user = userEvent.setup();

    render(<ComposePage />);
    await typeAddressAndLeave(user, 'info@corp.com');

    const flag = await screen.findByRole('alert');

    expect(flag).toHaveClass('warn');
    expect(flag.textContent).toMatch(/role inbox/i);
    expect(flag.textContent).toMatch(/reputation/i);
  });

  it('names a disposable domain specifically', async () => {
    routeApi({ verification: { status: 'warn', reasons: ['disposable_domain'], hasMx: true } });
    const user = userEvent.setup();

    render(<ComposePage />);
    await typeAddressAndLeave(user, 'sam@mailinator.com');

    const flag = await screen.findByRole('alert');

    expect(flag.textContent).toMatch(/disposable/i);
    expect(flag.textContent).not.toMatch(/role inbox/i);
  });

  it('does NOT present the address as bad when the check could not complete', async () => {
    routeApi({ verification: { status: 'unknown', reasons: ['dns_timeout'], hasMx: false } });
    const user = userEvent.setup();

    const { container } = render(<ComposePage />);
    await typeAddressAndLeave(user);

    const flag = await screen.findByRole('status');

    expect(flag).toHaveClass('verify-flag');
    expect(flag).toHaveClass('unknown');
    expect(flag.textContent).toMatch(/could not finish checking/i);
    expect(flag.textContent).toMatch(/not a verdict/i);
    // A DNS hiccup is not a bad address, and must never read as one.
    expect(flag.textContent).not.toMatch(/bounce|invalid|not a valid/i);
    expect(container.querySelector('.verify-flag.invalid')).toBeNull();
    expect(container.querySelector('.verify-flag.warn')).toBeNull();
  });

  it('treats an unreachable server as unknown, never as a bad address', async () => {
    apiPost.mockImplementation(async (path) => {
      if (path === '/send/verify-recipient') throw new Error('Network error');
      return draft();
    });
    const user = userEvent.setup();

    const { container } = render(<ComposePage />);
    await typeAddressAndLeave(user);

    await waitFor(() => expect(container.querySelector('.verify-flag.unknown')).not.toBeNull());
    expect(container.querySelector('.verify-flag.invalid')).toBeNull();
    // The check failing is not a page error either.
    expect(container.querySelector('.msg.error')).toBeNull();
  });

  it('never disables "Review & send" on any verification result — advisory only', async () => {
    const verdicts = [
      { status: 'invalid', reasons: ['no_mx'], hasMx: false },
      { status: 'invalid', reasons: ['syntax'], hasMx: false },
      { status: 'warn', reasons: ['disposable_domain'], hasMx: true },
      { status: 'unknown', reasons: ['dns_timeout'], hasMx: false }
    ];

    for (const verification of verdicts) {
      apiPost.mockReset();
      routeApi({ verification });
      const user = userEvent.setup();
      const view = render(<ComposePage />);

      await user.type(screen.getByLabelText(TO_FIELD), TO);
      await user.type(screen.getByLabelText('Subject'), SUBJECT);
      await user.type(screen.getByLabelText('Email body'), 'hey Sam');

      await waitFor(() => expect(verifyCalls().length).toBeGreaterThan(0));

      // A flag, not a gate. The user may know something we do not.
      expect(screen.getByRole('button', REVIEW)).toBeEnabled();

      view.unmount();
    }
  });

  it('clears the flag as soon as the address changes', async () => {
    routeApi({ verification: { status: 'invalid', reasons: ['no_mx'], hasMx: false } });
    const user = userEvent.setup();

    const { container } = render(<ComposePage />);
    const field = screen.getByLabelText(TO_FIELD);

    await typeAddressAndLeave(user);
    await screen.findByRole('alert');

    await user.type(field, 'x');

    // A verdict about the old address must never sit under the new one.
    expect(container.querySelector('.verify-flag')).toBeNull();
    expect(container.querySelector('.verify-line')).toBeNull();
  });

  it('re-checks once the address has actually changed', async () => {
    routeApi();
    const user = userEvent.setup();

    render(<ComposePage />);
    const field = screen.getByLabelText(TO_FIELD);

    await typeAddressAndLeave(user);
    await waitFor(() => expect(verifyCalls()).toHaveLength(1));

    await user.type(field, 'x');
    await user.tab();

    await waitFor(() => expect(verifyCalls()).toHaveLength(2));
    expect(verifyCalls()[1][1]).toEqual({ to: `${TO}x` });
  });

  it('does not re-check an unchanged address on every blur', async () => {
    routeApi();
    const user = userEvent.setup();

    render(<ComposePage />);
    const field = screen.getByLabelText(TO_FIELD);

    await typeAddressAndLeave(user);
    await waitFor(() => expect(verifyCalls()).toHaveLength(1));

    await user.click(field);
    await user.tab();
    await user.click(field);
    await user.tab();

    expect(verifyCalls()).toHaveLength(1);
  });
});
