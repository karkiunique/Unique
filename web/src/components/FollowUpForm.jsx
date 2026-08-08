import { useState } from 'react';

import ConfirmSendDialog from './ConfirmSendDialog.jsx';
import Icon from './Icon.jsx';

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
 * The subject is the thread's, passed through untouched: the server adds the
 * "Re: " for a threaded send, so prefixing it here would be doing it twice.
 */
export default function FollowUpForm({ to, subject, threadId, inReplyTo, onSent, onClose }) {
  const [body, setBody] = useState('');
  const [confirming, setConfirming] = useState(false);

  const recipient = typeof to === 'string' ? to.trim() : '';
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
          subject={subject}
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
