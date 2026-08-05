import { useEffect, useState } from 'react';

import { api } from '../lib/api.js';

/**
 * Reply detection on mail you sent. Explicitly NOT an inbox: the server only
 * ever reads `in:sent` threads, only their headers, and stores none of it — the
 * reply state is re-derived from Gmail on every poll.
 */

const POLL_MS = 30000;

function formatSentAt(value) {
  if (typeof value !== 'string' || value === '') return 'unknown time';

  const parsed = Date.parse(value);

  return Number.isNaN(parsed) ? 'unknown time' : new Date(parsed).toLocaleString();
}

function subjectOf(thread) {
  const subject = thread?.subject;
  return typeof subject === 'string' && subject.trim() !== '' ? subject : '(no subject)';
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

  return (
    <main className="shell top">
      <div className="card wide">
        <h1>Sent &amp; replies</h1>
        <p className="muted">
          Reply detection on mail you sent from this account. This is not an inbox — nothing else
          in your mailbox is read, and none of it is stored. Refreshes every 30 seconds.
        </p>

        {error ? <p className="error">{error}</p> : null}
        {loaded && !error && threads.length === 0 ? (
          <p className="muted">Nothing sent from here yet.</p>
        ) : null}

        <div className="rows">
          {threads.map((thread, index) => (
            <article className="row" key={thread?.threadId ?? index}>
              <div className="badges">
                <span className="badge">{formatSentAt(thread?.sentAt)}</span>
                {thread?.replied ? <span className="badge on">REPLIED</span> : null}
              </div>
              <h3>{subjectOf(thread)}</h3>
              <p className="muted">{typeof thread?.to === 'string' ? thread.to : ''}</p>
            </article>
          ))}
        </div>
      </div>
    </main>
  );
}
