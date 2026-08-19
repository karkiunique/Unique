import { useState } from 'react';

import ErrorNotice from './ErrorNotice.jsx';
import Icon from './Icon.jsx';
import { api } from '../lib/api.js';

/**
 * The send confirmation step.
 *
 * What is rendered here is what goes out: the full To, Subject and Body, in
 * full, including the unsubscribe line. No truncation, no ellipsis, no summary —
 * a confirmation screen that shows an approximation is worse than none, because
 * it buys consent for something the user never actually read. The payload is
 * built from the same values that are on screen, with nothing re-fetched,
 * re-generated or normalised in between.
 *
 * POST /send is called from the Send click and from nowhere else. This is the
 * convenient half of the gate; the binding half is server-side in routes/send.js,
 * which rejects any request without `confirmed: true`.
 *
 * A follow-up uses this same dialog rather than one of its own: it passes
 * `threadId` and `inReplyTo` so the message lands in an existing Gmail thread.
 * One dialog, one call to /send — a second confirmation UI would be a second
 * thing to keep watertight.
 */
export default function ConfirmSendDialog({
  to,
  // Present only for a daily-queue letter. It switches the POST to the LEAD send
  // route, where the approval gate and the fidelity floor are enforced against the
  // stored row. Everything rendered above stays byte-identical either way: one
  // confirmation UI, because a second would be a second thing to keep watertight.
  leadId,
  recipientName,
  subject,
  body,
  threadId,
  inReplyTo,
  doneLabel = 'Write another',
  doneIcon = 'plus',
  onCancel,
  onSent,
  onWriteAnother
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // The recovery code the server sent with the failure, if any.
  const [errorAction, setErrorAction] = useState(null);
  const [result, setResult] = useState(null);

  async function confirmSend() {
    setError(null);
    setErrorAction(null);
    setBusy(true);
    try {
      // Exactly the values displayed above, plus the explicit confirmation.
      const payload = { to, subject, body, confirmed: true };
      // Threading only — a first send carries neither, and neither changes a byte
      // of what was just approved.
      if (typeof threadId === 'string' && threadId !== '') payload.threadId = threadId;
      if (typeof inReplyTo === 'string' && inReplyTo !== '') payload.inReplyTo = inReplyTo;

      // The lead route derives the recipient from the row rather than the body, so
      // `to` is not sent: the address a client supplied could differ from the one
      // that was approved.
      const sent = leadId
        ? await api.post(`/leads/${encodeURIComponent(leadId)}/send`, {
            subject,
            body,
            confirmed: true
          })
        : await api.post('/send', payload);
      setResult(sent ?? {});
      if (typeof onSent === 'function') onSent(sent ?? {});
    } catch (err) {
      setError(err.message);
      setErrorAction(err.action ?? null);
      // Only re-enable on failure: a resolved send must never be clickable twice.
      setBusy(false);
    }
  }

  function stopOverlayClose(event) {
    event.stopPropagation();
  }

  if (result) {
    // No overlay dismissal from here: the letter has already left, so a stray
    // click must not quietly close the record of what went where.
    return (
      <div className="modal-overlay">
        <div className="block modal-sheet" role="dialog" aria-label="Email sent">
          <div className="sent-view">
            <span className="stamp green sent-stamp">
              <Icon name="check" />
              Sent
            </span>
            <h2>It&apos;s in {recipientName || to}&apos;s inbox.</h2>
            <p className="dim">We&apos;ll watch the thread and flag any reply in your register.</p>

            <div className="rowline sent-ids">
              <span className="mono faint sent-id">{result.messageId ?? 'unknown'}</span>
              <span className="mono faint sent-id">{result.threadId ?? 'unknown'}</span>
            </div>

            <button
              type="button"
              className="btn sent-again"
              onClick={() => {
                if (typeof onWriteAnother === 'function') onWriteAnother();
              }}
            >
              <Icon name={doneIcon} />
              {doneLabel}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="modal-overlay"
      onClick={() => {
        if (!busy && typeof onCancel === 'function') onCancel();
      }}
    >
      <div
        className="block modal-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm send"
        onClick={stopOverlayClose}
      >
        <div className="modal-stamp">
          <span className="stamp">For your approval</span>
        </div>

        <div className="kicker red">Final read</div>
        <h2 className="confirm-title">Send this letter?</h2>
        <p className="dim confirm-caption">
          Exactly this leaves your Gmail. Nothing is rewritten after you confirm.
        </p>

        <div className="hr ink" />

        <div className="confirm-row">
          <span className="mono k">TO</span>
          <span className="confirm-to">{to}</span>
        </div>

        <div className="confirm-letter">
          <div className="confirm-row plain">
            <span className="mono k">SUBJECT</span>
            <span className="confirm-subject">{subject}</span>
          </div>
          <p className="confirm-body">{body}</p>
        </div>

        <ErrorNotice message={error} action={errorAction} />

        <div className="rowline confirm-actions">
          <button type="button" className="btn red" onClick={confirmSend} disabled={busy}>
            <Icon name={busy ? 'loader' : 'send'} />
            {busy ? 'Sending…' : 'Send from my Gmail'}
          </button>
          <button type="button" className="linkbtn" onClick={onCancel} disabled={busy}>
            ← Keep editing
          </button>
        </div>
      </div>
    </div>
  );
}
