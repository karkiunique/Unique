import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const { default: ConfirmSendDialog } = await import('../src/components/ConfirmSendDialog.jsx');

const TO = 'sam@corp.com';
const SUBJECT = 'about the launch';
/**
 * Deliberately ragged — leading and trailing whitespace, and a "blank" line that
 * is actually spaces. What the user read is what leaves their Gmail, byte for
 * byte, so any tidying between the screen and the payload (a .trim(), a collapse
 * of blank lines) has to fail the assertions below rather than pass unnoticed.
 */
const BODY = [
  '  ',
  'hey Sam',
  '   ',
  'saw the launch go out. worth 15 minutes next week?',
  '',
  'thanks,',
  'Ana',
  '',
  "Don't want emails from me? [Unsubscribe](http://localhost:5173/u/abc.def)",
  '  '
].join('\n');

// The redesign renamed the buttons; what they do is unchanged.
const SEND = { name: 'Send from my Gmail' };
const SENDING = { name: 'Sending…' };
const CANCEL = { name: /keep editing/i };

/** A promise we can leave pending, so "in flight" is observable. */
function deferred() {
  const box = {};
  box.promise = new Promise((resolve, reject) => {
    box.resolve = resolve;
    box.reject = reject;
  });
  return box;
}

function renderDialog(overrides = {}) {
  const onCancel = vi.fn();
  const onSent = vi.fn();
  const result = render(
    <ConfirmSendDialog
      to={TO}
      subject={SUBJECT}
      body={BODY}
      onCancel={onCancel}
      onSent={onSent}
      {...overrides}
    />
  );
  return { ...result, onCancel, onSent };
}

beforeEach(() => {
  apiPost.mockReset();
  navigateTo.mockReset();
});

describe('ConfirmSendDialog — what is shown is what is sent', () => {
  it('renders the exact To, Subject and Body, including the unsubscribe line', () => {
    const { container } = renderDialog();

    expect(container.querySelector('.confirm-to').textContent).toBe(TO);
    expect(container.querySelector('.confirm-subject').textContent).toBe(SUBJECT);
    // Byte-for-byte: no truncation, no ellipsis, no paraphrase.
    expect(container.querySelector('.confirm-body').textContent).toBe(BODY);
    expect(container.querySelector('.confirm-body').textContent).toContain(
      "Don't want emails from me? [Unsubscribe](http://localhost:5173/u/abc.def)"
    );
    expect(container.querySelector('.confirm-body').textContent).not.toContain('…');
  });

  it('does NOT call /send on render — only after the explicit Send click', async () => {
    apiPost.mockResolvedValue({ messageId: 'msg-1', threadId: 'thr-1' });
    const user = userEvent.setup();

    renderDialog();

    expect(apiPost).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', SEND));

    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost.mock.calls[0][0]).toBe('/send');
  });

  it('includes confirmed: true in the payload', async () => {
    apiPost.mockResolvedValue({ messageId: 'msg-1', threadId: 'thr-1' });
    const user = userEvent.setup();

    renderDialog();
    await user.click(screen.getByRole('button', SEND));

    expect(apiPost.mock.calls[0][1].confirmed).toBe(true);
  });

  it('sends the subject and body byte-for-byte as displayed', async () => {
    apiPost.mockResolvedValue({ messageId: 'msg-1', threadId: 'thr-1' });
    const user = userEvent.setup();

    const { container } = renderDialog();

    const shownSubject = container.querySelector('.confirm-subject').textContent;
    const shownBody = container.querySelector('.confirm-body').textContent;
    const shownTo = container.querySelector('.confirm-to').textContent;

    await user.click(screen.getByRole('button', SEND));

    const payload = apiPost.mock.calls[0][1];
    expect(payload.subject).toBe(shownSubject);
    expect(payload.body).toBe(shownBody);
    expect(payload.to).toBe(shownTo);
  });

  it('shows the messageId and threadId once the send resolves', async () => {
    apiPost.mockResolvedValue({ messageId: 'msg-1', threadId: 'thr-1' });
    const user = userEvent.setup();

    const { onSent } = renderDialog();
    await user.click(screen.getByRole('button', SEND));

    expect(await screen.findByText('msg-1')).toBeInTheDocument();
    expect(screen.getByText('thr-1')).toBeInTheDocument();
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
  });
});

describe('ConfirmSendDialog — cancelling and failures', () => {
  it('Cancel sends nothing and hands control back to the caller', async () => {
    const user = userEvent.setup();

    const { onCancel } = renderDialog();
    await user.click(screen.getByRole('button', CANCEL));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('disables the send button while in flight so it cannot double-send', async () => {
    const pending = deferred();
    apiPost.mockReturnValue(pending.promise);
    const user = userEvent.setup();

    renderDialog();
    const button = screen.getByRole('button', SEND);
    await user.click(button);

    // Relabelled and disabled: a second click cannot reach the handler.
    expect(screen.getByRole('button', SENDING)).toBeDisabled();
    expect(screen.queryByRole('button', SEND)).not.toBeInTheDocument();
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it('renders the server error message and re-enables the button', async () => {
    const err = new Error('Gmail access was revoked, please reconnect Gmail');
    err.status = 400;
    apiPost.mockRejectedValue(err);
    const user = userEvent.setup();

    const { container } = renderDialog();
    await user.click(screen.getByRole('button', SEND));

    expect(
      await screen.findByText('Gmail access was revoked, please reconnect Gmail')
    ).toBeInTheDocument();
    expect(container.querySelector('.error')).toHaveTextContent('Gmail access was revoked');
    expect(screen.getByRole('button', SEND)).toBeEnabled();
  });
});

/**
 * The send fails here, so the way out has to be here. Describing "please
 * reconnect Gmail" with no button leaves the user stuck on the last screen of
 * the flow with nothing to click.
 */
describe('ConfirmSendDialog — recovering a Gmail grant', () => {
  const RECONNECT = { name: 'Reconnect Gmail' };
  const CONSENT_URL = 'https://accounts.google.com/o/oauth2/v2/auth?scope=gmail.send';

  const SCOPE_MESSAGE = 'Gmail needs re-approval for a new permission, please reconnect Gmail';

  function scopeError(message = SCOPE_MESSAGE) {
    const err = new Error(message);
    err.status = 400;
    err.action = 'reconnect_gmail';
    return err;
  }

  async function failSendWith(err) {
    apiPost.mockImplementation(async (path) => {
      if (path === '/gmail/connect') return { url: CONSENT_URL };
      throw err;
    });

    const user = userEvent.setup();
    const view = renderDialog();
    await user.click(screen.getByRole('button', SEND));

    return { user, ...view };
  }

  it('offers a Reconnect Gmail button when the server names that recovery', async () => {
    await failSendWith(scopeError());

    expect(await screen.findByRole('button', RECONNECT)).toBeInTheDocument();
    expect(screen.getByText(SCOPE_MESSAGE)).toBeInTheDocument();
  });

  it('POSTs /gmail/connect and navigates to the consent URL it returns', async () => {
    const { user } = await failSendWith(scopeError());

    await user.click(await screen.findByRole('button', RECONNECT));

    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith(CONSENT_URL));
    expect(apiPost.mock.calls.filter(([path]) => path === '/gmail/connect')).toHaveLength(1);
  });

  it('keys off the action code, not the wording of the message', async () => {
    // A message that never says "reconnect" still gets the button.
    await failSendWith(scopeError('Gmail would not accept that request'));

    expect(await screen.findByRole('button', RECONNECT)).toBeInTheDocument();
  });

  it('does NOT offer it for an ordinary failure', async () => {
    const err = new Error('Gmail rejected the message');
    err.status = 502;
    apiPost.mockRejectedValue(err);
    const user = userEvent.setup();

    renderDialog();
    await user.click(screen.getByRole('button', SEND));

    expect(await screen.findByText('Gmail rejected the message')).toBeInTheDocument();
    expect(screen.queryByRole('button', RECONNECT)).not.toBeInTheDocument();
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it('never sends while recovering — the reconnect click posts no message', async () => {
    const { user } = await failSendWith(scopeError());

    await user.click(await screen.findByRole('button', RECONNECT));

    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    // One /send (the click that failed) and nothing more.
    expect(apiPost.mock.calls.filter(([path]) => path === '/send')).toHaveLength(1);
  });
});

/**
 * A follow-up reuses this dialog rather than getting one of its own, so every
 * gate assertion above is re-asserted here with the threading props present. The
 * extra props may add ids to the payload; they may not soften a single guarantee
 * about what was displayed, what is sent, or when.
 */
describe('ConfirmSendDialog — following up inside a thread', () => {
  const THREAD_ID = 't-1';
  const IN_REPLY_TO = '<m2@mail.example>';

  function renderFollowUp(overrides = {}) {
    return renderDialog({ threadId: THREAD_ID, inReplyTo: IN_REPLY_TO, ...overrides });
  }

  it('sends no threadId or inReplyTo for an ordinary first send', async () => {
    apiPost.mockResolvedValue({ messageId: 'msg-1', threadId: 'thr-1' });
    const user = userEvent.setup();

    renderDialog();
    await user.click(screen.getByRole('button', SEND));

    expect(apiPost.mock.calls[0][1]).toEqual({
      to: TO,
      subject: SUBJECT,
      body: BODY,
      confirmed: true
    });
  });

  it('does NOT call /send on render with threading props — only on the Send click', async () => {
    apiPost.mockResolvedValue({ messageId: 'msg-1', threadId: 't-1' });
    const user = userEvent.setup();

    renderFollowUp();

    expect(apiPost).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', SEND));

    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost.mock.calls[0][0]).toBe('/send');
  });

  it('sends the displayed To, Subject and Body byte-for-byte, plus the thread ids', async () => {
    apiPost.mockResolvedValue({ messageId: 'msg-1', threadId: 't-1' });
    const user = userEvent.setup();

    const { container } = renderFollowUp();

    // The full body is on screen first — no truncation, no ellipsis.
    expect(container.querySelector('.confirm-body').textContent).toBe(BODY);
    expect(container.querySelector('.confirm-body').textContent).not.toContain('…');

    const shownTo = container.querySelector('.confirm-to').textContent;
    const shownSubject = container.querySelector('.confirm-subject').textContent;
    const shownBody = container.querySelector('.confirm-body').textContent;

    await user.click(screen.getByRole('button', SEND));

    expect(apiPost.mock.calls[0][1]).toEqual({
      to: shownTo,
      subject: shownSubject,
      body: shownBody,
      threadId: THREAD_ID,
      inReplyTo: IN_REPLY_TO,
      confirmed: true
    });
  });

  /**
   * The dialog is the last place a subject may be touched, so it touches none:
   * the caller hands it the final string — "Re: " and all — and it displays and
   * posts that. FollowUpForm owns the prefix precisely so it lands before this
   * screen renders; see ThreadFollowUp.test.jsx for that guarantee end to end.
   */
  it('adds nothing to the subject of a follow-up — no "Re: " appears here', async () => {
    apiPost.mockResolvedValue({ messageId: 'msg-1', threadId: 't-1' });
    const user = userEvent.setup();

    const { container } = renderFollowUp({ subject: `Re: ${SUBJECT}` });

    expect(container.querySelector('.confirm-subject').textContent).toBe(`Re: ${SUBJECT}`);

    await user.click(screen.getByRole('button', SEND));

    expect(apiPost.mock.calls[0][1].subject).toBe(`Re: ${SUBJECT}`);
    // One prefix, because the caller supplied one. The dialog never stacks another.
    expect(apiPost.mock.calls[0][1].subject).not.toMatch(/^re:\s*re:/i);
  });

  it('passes a plain subject through untouched even with the threading props set', async () => {
    apiPost.mockResolvedValue({ messageId: 'msg-1', threadId: 't-1' });
    const user = userEvent.setup();

    const { container } = renderFollowUp();

    const shownSubject = container.querySelector('.confirm-subject').textContent;
    expect(shownSubject).toBe(SUBJECT);

    await user.click(screen.getByRole('button', SEND));

    expect(apiPost.mock.calls[0][1].subject).toBe(shownSubject);
  });

  it('disables the send button while a follow-up is in flight', async () => {
    const pending = deferred();
    apiPost.mockReturnValue(pending.promise);
    const user = userEvent.setup();

    renderFollowUp();
    await user.click(screen.getByRole('button', SEND));

    expect(screen.getByRole('button', SENDING)).toBeDisabled();
    expect(screen.queryByRole('button', SEND)).not.toBeInTheDocument();
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it('Cancel on a follow-up sends nothing', async () => {
    const user = userEvent.setup();

    const { onCancel } = renderFollowUp();
    await user.click(screen.getByRole('button', CANCEL));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('lets the caller name the way out after the send, defaulting to "Write another"', async () => {
    apiPost.mockResolvedValue({ messageId: 'msg-1', threadId: 't-1' });
    const user = userEvent.setup();

    renderFollowUp({ doneLabel: 'Back to the thread', doneIcon: 'arrow-left' });
    await user.click(screen.getByRole('button', SEND));

    expect(await screen.findByRole('button', { name: 'Back to the thread' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Write another' })).not.toBeInTheDocument();
  });

  it('still says "Write another" when no label is given', async () => {
    apiPost.mockResolvedValue({ messageId: 'msg-1', threadId: 'thr-1' });
    const user = userEvent.setup();

    renderDialog();
    await user.click(screen.getByRole('button', SEND));

    expect(await screen.findByRole('button', { name: 'Write another' })).toBeInTheDocument();
  });
});

describe('ConfirmSendDialog — the overlay', () => {
  it('closes on an overlay click while still confirming, and sends nothing', async () => {
    const user = userEvent.setup();

    const { container, onCancel } = renderDialog();
    await user.click(container.querySelector('.modal-overlay'));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('does NOT close on an overlay click once the letter has been sent', async () => {
    apiPost.mockResolvedValue({ messageId: 'msg-1', threadId: 'thr-1' });
    const user = userEvent.setup();

    const { container, onCancel } = renderDialog();
    await user.click(screen.getByRole('button', SEND));
    await screen.findByText('msg-1');

    await user.click(container.querySelector('.modal-overlay'));

    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByText('msg-1')).toBeInTheDocument();
  });

  it('a click inside the sheet never closes the dialog', async () => {
    const user = userEvent.setup();

    const { container, onCancel } = renderDialog();
    await user.click(container.querySelector('.confirm-body'));

    expect(onCancel).not.toHaveBeenCalled();
  });
});
