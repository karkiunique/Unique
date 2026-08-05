import { useState } from 'react';

import { api } from '../lib/api.js';

/**
 * The send confirmation step.
 *
 * What is rendered here is what goes out: the full To, Subject and Body, in
 * full, including the unsubscribe line. No truncation, no ellipsis, no summary —
 * a confirmation screen that shows an approximation is worse than none, because
 * it buys consent for something the user never actually read.
 *
 * POST /send is called from the Send click and from nowhere else. This is the
 * convenient half of the gate; the binding half is server-side in routes/send.js,
 * which rejects any request without `confirmed: true`.
 */
export default function ConfirmSendDialog({ to, subject, body, onCancel, onSent }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  async function confirmSend() {
    setError(null);
    setBusy(true);
    try {
      // Exactly the values displayed above, plus the explicit confirmation.
      const payload = await api.post('/send', { to, subject, body, confirmed: true });
      setResult(payload ?? {});
      if (typeof onSent === 'function') onSent(payload ?? {});
    } catch (err) {
      setError(err.message);
      // Only re-enable on failure: a resolved send must never be clickable twice.
      setBusy(false);
    }
  }

  if (result) {
    return (
      <section className="confirm" role="dialog" aria-label="Email sent">
        <h2>Sent</h2>
        <p className="notice">This email is now in {to}&apos;s inbox.</p>
        <dl className="facts">
          <dt>Message id</dt>
          <dd>{result.messageId ?? 'unknown'}</dd>
          <dt>Thread id</dt>
          <dd>{result.threadId ?? 'unknown'}</dd>
        </dl>
      </section>
    );
  }

  return (
    <section className="confirm" role="dialog" aria-label="Confirm send">
      <h2>Send this email?</h2>
      <p className="muted">
        This is exactly what will be sent from your Gmail account. Nothing is rewritten after you
        confirm.
      </p>

      <dl className="facts">
        <dt>To</dt>
        <dd className="confirm-to">{to}</dd>
        <dt>Subject</dt>
        <dd className="confirm-subject">{subject}</dd>
      </dl>

      <p className="body-text confirm-body">{body}</p>

      {error ? <p className="error">{error}</p> : null}

      <div className="actions">
        <button type="button" onClick={confirmSend} disabled={busy}>
          {busy ? 'Sending…' : 'Send email'}
        </button>
        <button type="button" className="link" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </section>
  );
}
