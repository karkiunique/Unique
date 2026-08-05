import { useEffect, useState } from 'react';

import { api } from '../lib/api.js';

/**
 * Dev-only ingestion preview (GET /api/dev/ingest-preview).
 *
 * The point of this component is to make a bad corpus obvious BEFORE a voice
 * profile is built from it: junk in the corpus means the profile learns other
 * people's writing. It renders the cleaned bodies and flags rows that look like
 * the cleaner missed something.
 *
 * When the dev route is disabled the server answers 404 and this renders nothing
 * at all — it must be completely invisible outside a dev environment. Bodies are
 * rendered and discarded; nothing here is logged or persisted.
 */

const PREVIEW_PATH = '/dev/ingest-preview';
const LONG_EMAIL_CHARS = 400;
const WHOLE_THREAD_CHARS = 3000;

// Quoted-printable that was never decoded.
const QUOTED_PRINTABLE = /=20|=E2=|=C2=/;
// A '<' followed by a letter (tag markup) or a leftover entity.
const HTML_RESIDUE = /<[a-zA-Z]|&nbsp;|&amp;/;

function num(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Every reason this row deserves a human look. Empty array = looks clean. */
function suspectReasons(email) {
  const cleaned = typeof email?.cleaned === 'string' ? email.cleaned : '';
  const cleanedChars = num(email?.cleanedChars, cleaned.length);
  const rawChars = num(email?.rawChars, 0);
  const strippedChars = num(email?.strippedChars, 0);
  const removed = email?.removed && typeof email.removed === 'object' ? email.removed : {};
  const reasons = [];

  if (removed.quotedReply === false) {
    reasons.push('No quoted reply stripped — a reply chain may have survived');
  }
  if (strippedChars === 0 && Math.max(rawChars, cleanedChars) > LONG_EMAIL_CHARS) {
    reasons.push('Nothing was removed from a long email');
  }
  if (cleanedChars > WHOLE_THREAD_CHARS) {
    reasons.push('Very long — looks like a whole thread, not one message');
  }
  if (QUOTED_PRINTABLE.test(cleaned)) {
    reasons.push('Undecoded quoted-printable (=20, =E2=, =C2=)');
  }
  if (HTML_RESIDUE.test(cleaned)) {
    reasons.push('HTML residue in the cleaned text');
  }

  return reasons;
}

function Badge({ label, on }) {
  return <span className={on ? 'badge on' : 'badge off'}>{label}</span>;
}

function EmailRow({ email, position, includeRaw }) {
  const [open, setOpen] = useState(false);

  const reasons = suspectReasons(email);
  const removed = email?.removed && typeof email.removed === 'object' ? email.removed : {};
  const cleaned = typeof email?.cleaned === 'string' ? email.cleaned : '';
  const raw = typeof email?.raw === 'string' ? email.raw : null;
  const index = num(email?.index, position);

  return (
    <article className={reasons.length > 0 ? 'row suspect' : 'row'}>
      <div className="badges">
        <span className="badge">email {index}</span>
        <span className="badge">{num(email?.cleanedChars)} cleaned</span>
        <span className="badge">{num(email?.rawChars)} raw</span>
        <span className="badge">{num(email?.strippedChars)} stripped</span>
        <Badge label={`quoted reply ${removed.quotedReply ? 'removed' : 'not removed'}`} on={removed.quotedReply === true} />
        <Badge label={`signature ${removed.signature ? 'removed' : 'not removed'}`} on={removed.signature === true} />
        <Badge label={`html ${removed.html ? 'detected' : 'none'}`} on={removed.html !== true} />
      </div>

      {reasons.length > 0 ? (
        <ul className="chips">
          {reasons.map((reason) => (
            <li key={reason} className="chip suspect-chip">
              {reason}
            </li>
          ))}
        </ul>
      ) : null}

      <button type="button" className="link small" onClick={() => setOpen(!open)}>
        {open ? 'Hide body' : 'Show body'}
      </button>

      {open && includeRaw && raw !== null ? (
        <div className="split">
          <div>
            <h3>Raw (pre-clean)</h3>
            <p className="body-text">{raw}</p>
          </div>
          <div>
            <h3>Cleaned</h3>
            <p className="body-text">{cleaned}</p>
          </div>
        </div>
      ) : null}

      {open && !(includeRaw && raw !== null) ? <p className="body-text">{cleaned}</p> : null}
    </article>
  );
}

export default function CorpusViewer() {
  const [data, setData] = useState(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState(null);
  const [includeRaw, setIncludeRaw] = useState(false);

  useEffect(() => {
    let active = true;

    api
      .get(includeRaw ? `${PREVIEW_PATH}?includeRaw=1` : PREVIEW_PATH)
      .then((payload) => {
        if (!active) return;
        setData(payload ?? null);
        setError(null);
      })
      .catch((err) => {
        if (!active) return;
        // 404 = dev routes are off. Stay completely invisible.
        if (err?.status === 404) {
          setHidden(true);
          setData(null);
          return;
        }
        setError(err.message);
      });

    return () => {
      active = false;
    };
  }, [includeRaw]);

  if (hidden) return null;
  if (error) return <p className="error">Ingestion preview: {error}</p>;
  if (!data) return null;

  const summary = data.summary && typeof data.summary === 'object' ? data.summary : {};
  const emails = Array.isArray(data.emails) ? data.emails : [];
  const suspectCount = emails.filter((email) => suspectReasons(email).length > 0).length;

  return (
    <section className="corpus">
      <h2>Ingestion preview</h2>

      <dl className="facts">
        <dt>Emails ingested</dt>
        <dd>{num(summary.messageCount, emails.length)}</dd>
        <dt>Cleaned characters</dt>
        <dd>{num(summary.totalCleanedChars)}</dd>
        <dt>Over char budget</dt>
        <dd>{summary.overCharBudget ? 'yes' : 'no'}</dd>
        <dt>Capped at</dt>
        <dd>{num(summary.cappedAt)}</dd>
      </dl>

      <p className={suspectCount > 0 ? 'error' : 'notice'}>
        {suspectCount} of {emails.length} emails look suspect
      </p>

      <label className="inline">
        <input
          type="checkbox"
          checked={includeRaw}
          onChange={(event) => setIncludeRaw(event.target.checked)}
        />
        Include raw pre-clean text
      </label>

      <div className="rows">
        {emails.map((email, position) => (
          <EmailRow
            key={`${num(email?.index, position)}-${position}`}
            email={email}
            position={position}
            includeRaw={includeRaw}
          />
        ))}
      </div>
    </section>
  );
}
