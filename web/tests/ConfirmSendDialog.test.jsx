import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));

// No real network in tests.
vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: apiPost, patch: vi.fn() },
  apiFetch: vi.fn()
}));

const { default: ConfirmSendDialog } = await import('../src/components/ConfirmSendDialog.jsx');

const TO = 'sam@corp.com';
const SUBJECT = 'about the launch';
const BODY = [
  'hey Sam',
  '',
  'saw the launch go out. worth 15 minutes next week?',
  '',
  'thanks,',
  'Ana',
  '',
  "Don't want emails from me? [Unsubscribe](http://localhost:5173/u/abc.def)"
].join('\n');

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

    await user.click(screen.getByRole('button', { name: 'Send email' }));

    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost.mock.calls[0][0]).toBe('/send');
  });

  it('includes confirmed: true in the payload', async () => {
    apiPost.mockResolvedValue({ messageId: 'msg-1', threadId: 'thr-1' });
    const user = userEvent.setup();

    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Send email' }));

    expect(apiPost.mock.calls[0][1].confirmed).toBe(true);
  });

  it('sends the subject and body byte-for-byte as displayed', async () => {
    apiPost.mockResolvedValue({ messageId: 'msg-1', threadId: 'thr-1' });
    const user = userEvent.setup();

    const { container } = renderDialog();

    const shownSubject = container.querySelector('.confirm-subject').textContent;
    const shownBody = container.querySelector('.confirm-body').textContent;
    const shownTo = container.querySelector('.confirm-to').textContent;

    await user.click(screen.getByRole('button', { name: 'Send email' }));

    const payload = apiPost.mock.calls[0][1];
    expect(payload.subject).toBe(shownSubject);
    expect(payload.body).toBe(shownBody);
    expect(payload.to).toBe(shownTo);
  });

  it('shows the messageId and threadId once the send resolves', async () => {
    apiPost.mockResolvedValue({ messageId: 'msg-1', threadId: 'thr-1' });
    const user = userEvent.setup();

    const { onSent } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Send email' }));

    expect(await screen.findByText('msg-1')).toBeInTheDocument();
    expect(screen.getByText('thr-1')).toBeInTheDocument();
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
  });
});

describe('ConfirmSendDialog — cancelling and failures', () => {
  it('Cancel sends nothing and hands control back to the caller', async () => {
    const user = userEvent.setup();

    const { onCancel } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('disables the send button while in flight so it cannot double-send', async () => {
    const pending = deferred();
    apiPost.mockReturnValue(pending.promise);
    const user = userEvent.setup();

    renderDialog();
    const button = screen.getByRole('button', { name: 'Send email' });
    await user.click(button);

    // Relabelled and disabled: a second click cannot reach the handler.
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Send email' })).not.toBeInTheDocument();
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it('renders the server error message and re-enables the button', async () => {
    const err = new Error('Gmail access was revoked, please reconnect Gmail');
    err.status = 400;
    apiPost.mockRejectedValue(err);
    const user = userEvent.setup();

    const { container } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Send email' }));

    expect(
      await screen.findByText('Gmail access was revoked, please reconnect Gmail')
    ).toBeInTheDocument();
    expect(container.querySelector('.error')).toHaveTextContent('Gmail access was revoked');
    expect(screen.getByRole('button', { name: 'Send email' })).toBeEnabled();
  });
});
