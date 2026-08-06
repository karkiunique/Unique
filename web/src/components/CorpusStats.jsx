import { useEffect, useState } from 'react';

import { api } from '../lib/api.js';

/**
 * The corpus, in numbers — GET /api/voice/corpus-summary.
 *
 * Counts only, by design. The endpoint behind this returns no bodies, no
 * excerpts, no subjects and no recipients, so this strip is safe to render in
 * production. The per-email corpus with its cleaned text is a dev-only view
 * (CorpusViewer), which stays invisible outside a dev environment.
 */

const SUMMARY_PATH = '/voice/corpus-summary';
const PENDING = '—';

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The three cells, with the flagged count going red as soon as there is one. */
function cellsFor(summary) {
  if (!summary) {
    return [
      ['Emails taken down', PENDING, false],
      ['Characters cleaned', PENDING, false],
      ['Flagged for a look', PENDING, false]
    ];
  }

  const messages = count(summary.messageCount);
  const suspect = count(summary.suspectCount);

  return [
    ['Emails taken down', String(messages), false],
    ['Characters cleaned', count(summary.totalCleanedChars).toLocaleString(), false],
    ['Flagged for a look', `${suspect} of ${messages}`, suspect > 0]
  ];
}

export default function CorpusStats() {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;

    api
      .get(SUMMARY_PATH)
      .then((payload) => {
        if (!active) return;
        setSummary(payload ?? null);
        setError(null);
      })
      .catch((err) => {
        if (active) setError(err.message);
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <div>
      <div className="statstrip">
        {cellsFor(summary).map(([label, value, hot]) => (
          <div className="stat" key={label}>
            <div className="kicker">{label}</div>
            <div className={hot ? 'stat-value hot' : 'stat-value'}>{value}</div>
          </div>
        ))}
      </div>
      {error ? <p className="msg error">{error}</p> : null}
    </div>
  );
}
