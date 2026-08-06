import { useEffect, useState } from 'react';

import Icon from '../components/Icon.jsx';
import { PageHead } from '../components/Shell.jsx';
import { api } from '../lib/api.js';

/**
 * Section III — the register: every letter sent from this desk, and who wrote
 * back. Explicitly NOT an inbox: the server only ever reads `in:sent` threads,
 * only their headers, and stores none of it — the reply state is re-derived from
 * Gmail on every poll.
 */

const POLL_MS = 30000;
const UNKNOWN_SENT = { date: 'Unknown', time: '' };

/** Date and time as two lines, or a flat "Unknown" if the value is unusable. */
function sentParts(value) {
  if (typeof value !== 'string' || value === '') return UNKNOWN_SENT;

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return UNKNOWN_SENT;

  const at = new Date(parsed);

  return {
    date: at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase(),
    time: at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  };
}

function subjectOf(thread) {
  const subject = thread?.subject;
  return typeof subject === 'string' && subject.trim() !== '' ? subject : '(no subject)';
}

function RegisterRow({ thread, position }) {
  const sent = sentParts(thread?.sentAt);
  const replied = Boolean(thread?.replied);

  return (
    <div className={replied ? 'reg-row replied' : 'reg-row'}>
      <span className="reg-no">{String(position + 1).padStart(2, '0')}</span>

      <span className="reg-subject">
        <span className="t">{subjectOf(thread)}</span>
        <span className="a">{typeof thread?.to === 'string' ? thread.to : ''}</span>
      </span>

      <span className="reg-sent">
        {sent.date}
        <span className="time">{sent.time}</span>
      </span>

      <span className="reg-status">
        {replied ? (
          <span className="tag outline">
            <Icon name="corner-up-left" />
            Replied
          </span>
        ) : (
          <span className="mono reg-awaiting">· · ·</span>
        )}
      </span>
    </div>
  );
}

export default function ThreadsPage() {
  const [threads, setThreads] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;

    function load() {
      api
        .get('/threads')
        .then((payload) => {
          if (!active) return;
          setThreads(Array.isArray(payload?.threads) ? payload.threads : []);
          setError(null);
          setLoaded(true);
        })
        .catch((err) => {
          if (!active) return;
          setError(err.message);
          setLoaded(true);
        });
    }

    load();
    const timer = setInterval(load, POLL_MS);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const replied = threads.filter((thread) => thread?.replied).length;

  return (
    <>
      <PageHead
        kicker="Section III"
        title={
          <>
            The <em>register</em>.
          </>
        }
        sub="Every letter you've sent from this desk, and who has written back."
        aside={
          <div className="block--red pop replies-tally">
            <div className="kicker">Replies</div>
            <div className="serif tally">
              {replied}
              <span className="of">/{threads.length}</span>
            </div>
          </div>
        }
      />

      {error ? (
        <p className="msg error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="register">
        <div className="reg-head">
          <span className="reg-no">No.</span>
          <span className="reg-subject">Subject &amp; recipient</span>
          <span className="reg-sent">Sent</span>
          <span className="reg-status">Status</span>
        </div>

        {threads.map((thread, position) => (
          <RegisterRow
            key={thread?.threadId ?? position}
            thread={thread}
            position={position}
          />
        ))}

        {loaded && !error && threads.length === 0 ? (
          <p className="muted reg-empty">Nothing sent from here yet.</p>
        ) : null}
      </div>

      <p className="tick reg-note">
        <Icon name="lock" />
        Not an inbox — nothing else in your mailbox is read, and none of it is stored. Refreshes
        every 30s.
      </p>
    </>
  );
}
