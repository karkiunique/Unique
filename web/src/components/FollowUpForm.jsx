import { useState } from 'react';

import ConfirmSendDialog from './ConfirmSendDialog.jsx';
import Icon from './Icon.jsx';
import { withReplyPrefix } from '../lib/subject.js';

/**
 * Writing a follow-up inside an existing thread.
 *
 * This component composes and nothing else — it never imports the API client and
 * has no path to POST /send. The only way out of here to a real send is
 * ConfirmSendDialog, exactly as in the compose flow: a follow-up lands in a
 * stranger's inbox under the user's own name, so it earns the same final read of
 * the exact recipient, subject and body. There is deliberately no second
 * confirmation UI to keep in sync, and no shortcut past the one that exists.
 *
 * The "Re: " goes on HERE, before the dialog opens, and that placement is the
 * point: the dialog's promise is that exactly what it shows is what leaves Gmail,
 * so the subject has to be in its final form by the time the user reads it.
 * Prefixing after the confirmation would mean approving "X" and sending "Re: X" —
 * a rewrite of an approved field, however small. The server still applies the same
 * idempotent prefix on the way out, where it now changes nothing.
 */
export default function FollowUpForm({ to, subject, threadId, inReplyTo, onSent, onClose }) {
  const [body, setBody] = useState('');
  const [confirming, setConfirming] = useState(false);

  const recipient = typeof to === 'string' ? to.trim() : '';
  const replySubject = withReplyPrefix(subject);
  const canReview = recipient !== '' && body.trim() !== '';

  return (
    <div className="followup">
      <div className="rowline followup-head">
        <div className="kicker red">Follow up</div>
        <span className="mono faint">Replying to {recipient === '' ? 'unknown' : recipient}</span>
      </div>

      <textarea
        className="rtext followup-body"
        rows={7}
        aria-label="Follow-up body"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Write the follow-up in your own words. You read it again before it ships."
      />

      <p className="followup-note">
        It lands in this same thread, and Gmail shows it to them as a reply.
      </p>

      <div className="rowline followup-actions">
        <button
          type="button"
          className="btn"
          onClick={() => setConfirming(true)}
          disabled={!canReview}
        >
          <Icon name="stamp" />
          Review &amp; send
        </button>
        <button type="button" className="linkbtn" onClick={onClose}>
          ← Back to the thread
        </button>
      </div>

      {confirming ? (
        <ConfirmSendDialog
          to={recipient}
          subject={replySubject}
          body={body}
          threadId={threadId}
          inReplyTo={inReplyTo}
          doneLabel="Back to the thread"
          doneIcon="arrow-left"
          onCancel={() => setConfirming(false)}
          onSent={onSent}
          onWriteAnother={onClose}
        />
      ) : null}
    </div>
  );
}
