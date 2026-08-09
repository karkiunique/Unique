import { useEffect, useState } from 'react';

import FollowUpForm from './FollowUpForm.jsx';
import Icon from './Icon.jsx';
import { PageHead } from './Shell.jsx';
import { api } from '../lib/api.js';

/**
 * One conversation, in full: what was sent and whatever came back.
 *
 * The bodies here are real email content, and a reply is text a stranger wrote.
 * Every field is therefore rendered through ordinary React interpolation —
 * there is no dangerouslySetInnerHTML on this path and there must never be one.
 * Markup in a reply is characters to display, never instructions to run.
 *
 * Nothing is persisted or logged: the thread is fetched per view and lives in
 * component state only (CLAUDE.md Decisions, 2026-08-06).
 */

const NOT_FOUND = 404;

/** "Sam Rivera <sam@corp.com>" -> "sam@corp.com"; anything else, unchanged. */
export function emailAddress(value) {
  if (typeof value !== 'string') return '';

  const angled = value.match(/<([^>]+)>/);

  return (angled ? angled[1] : value).trim();
}

function lastMessage(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;

  return messages[messages.length - 1];
}

/**
 * Who a follow-up goes to: whoever spoke last. If that was the user, the thread
 * has had no reply yet and the original recipient is still the right address.
 */
export function followUpRecipient(messages) {
  const last = lastMessage(messages);
  if (!last) return '';

  return emailAddress(last.fromSelf ? last.to : last.from);
}

/** The Message-ID a reply must reference so it threads in the recipient's client. */
export function replyToMessageId(messages) {
  const last = lastMessage(messages);

  return typeof last?.messageId === 'string' ? last.messageId : '';
}

function threadSubject(messages) {
  const found = messages.find(
    (message) => typeof message?.subject === 'string' && message.subject.trim() !== ''
  );

  return found ? found.subject : '';
}

function stampOf(message) {
  const raw = message?.sentAt ?? message?.date;
  const parsed = typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (Number.isNaN(parsed)) return 'Unknown';

  const at = new Date(parsed);
  const day = at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  return `${day} · ${time}`;
}

function BackToRegister({ onBack }) {
  return (
    <button type="button" className="linkbtn thread-back" onClick={onBack}>
      <Icon name="arrow-left" />
      Back to the register
    </button>
  );
}

export default function ThreadDetail({ threadId, onBack }) {
  const [messages, setMessages] = useState([]);
  // 'loading' | 'ready' | 'missing' | 'error'
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);
  const [followingUp, setFollowingUp] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;

    // Only the first read blanks the view. A refresh after a follow-up must not
    // pull the conversation — or the sent confirmation sitting on top of it — away.
    if (reloadKey === 0) setStatus('loading');

    api
      .get(`/threads/${encodeURIComponent(threadId)}`)
      .then((payload) => {
        if (!active) return;
        setMessages(Array.isArray(payload?.messages) ? payload.messages : []);
        setError(null);
        setStatus('ready');
      })
      .catch((err) => {
        if (!active) return;
        // 404 means this thread is not in the user's send_log. That is a plain
        // "not here", not a fault — it must not read like something broke.
        if (err?.status === NOT_FOUND) {
          setStatus('missing');
          return;
        }
        setError(err.message);
        setStatus('error');
      });

    return () => {
      active = false;
    };
  }, [threadId, reloadKey]);

  if (status === 'loading') {
    return (
      <div className="thread-view">
        <BackToRegister onBack={onBack} />
        <p className="muted thread-note">Fetching the thread…</p>
      </div>
    );
  }

  if (status === 'missing') {
    return (
      <div className="thread-view">
        <BackToRegister onBack={onBack} />
        <div className="kicker thread-kicker">Not found</div>
        <p className="muted thread-note">
          That letter isn&apos;t in your register. It may have been deleted in Gmail.
        </p>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="thread-view">
        <BackToRegister onBack={onBack} />
        <p className="msg error" role="alert">
          {error}
        </p>
      </div>
    );
  }

  const subject = threadSubject(messages);

  return (
    <div className="thread-view">
      <BackToRegister onBack={onBack} />

      <PageHead
        kicker="Section III · One thread"
        title={<>{subject === '' ? '(no subject)' : subject}</>}
        sub={`${messages.length} ${messages.length === 1 ? 'message' : 'messages'} in this thread.`}
      />

      <div className="thread">
        {messages.map((message, index) => (
          <article
            key={message?.id ?? index}
            className={message?.fromSelf ? 'sheet msg-sheet from-self' : 'sheet msg-sheet'}
          >
            <header className="msg-head">
              <span className="mono msg-from">
                {emailAddress(message?.from) || 'Unknown sender'}
              </span>
              <span className="kicker msg-mark">{message?.fromSelf ? 'You sent' : 'Reply'}</span>
            </header>

            <div className="msg-meta">
              <span className="mono faint msg-to">
                To {emailAddress(message?.to) || 'unknown'}
              </span>
              <span className="mono faint msg-when">{stampOf(message)}</span>
            </div>

            <p className="msg-body">{typeof message?.body === 'string' ? message.body : ''}</p>
          </article>
        ))}
      </div>

      {followingUp ? (
        <FollowUpForm
          to={followUpRecipient(messages)}
          subject={subject}
          threadId={threadId}
          inReplyTo={replyToMessageId(messages)}
          onSent={() => setReloadKey((key) => key + 1)}
          onClose={() => setFollowingUp(false)}
        />
      ) : (
        <button
          type="button"
          className="btn red thread-followup"
          onClick={() => setFollowingUp(true)}
        >
          <Icon name="corner-up-left" />
          Follow up
        </button>
      )}
    </div>
  );
}
