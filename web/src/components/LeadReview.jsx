import { useEffect, useState } from 'react';

import Icon from './Icon.jsx';
import { api } from '../lib/api.js';
import { useAutoGrow } from '../lib/useAutoGrow.js';

/**
 * One recipient's letter, opened for review — the money screen.
 *
 * This is where a human reads the exact words before they go out under their own
 * name, so the letter is fetched one recipient at a time rather than shipped in
 * bulk with the campaign: a body has a reason to leave the database only when
 * somebody is actually reading it.
 *
 * Approving is one click on one letter that has been rendered on this screen.
 * There is no path here that approves anything unopened, and the server refuses
 * an approval for a recipient with no draft anyway — this component is the
 * courteous version of that refusal, never the enforcement.
 *
 * Editing withdraws approval, on the server as well as here: the approval was
 * for the old words. What the fields show is what would be sent — the edit wins
 * over the draft, exactly as the send gate resolves it.
 */

const LOW_FIDELITY = 80;
const NOT_FOUND = 404;

// Statuses where the letter is still the reviewer's to change.
const OPEN_STATUSES = ['generated', 'approved'];

function fullName(lead) {
  return [lead?.first_name, lead?.last_name]
    .filter((part) => typeof part === 'string' && part.trim() !== '')
    .join(' ');
}

function textOf(value) {
  return typeof value === 'string' ? value : '';
}

/** What would actually be sent: the user's edit wins over the model's draft. */
function letterOf(lead) {
  const edited = textOf(lead?.edited_body);

  return {
    subject: textOf(lead?.generated_subject),
    body: edited.trim() === '' ? textOf(lead?.generated_body) : edited
  };
}

export default function LeadReview({ leadId, onClose, onChanged }) {
  const [lead, setLead] = useState(null);
  // 'loading' | 'ready' | 'missing' | 'error'
  const [state, setState] = useState('loading');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  // Unsaved changes. The approval that follows carries them in the same request.
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const bodyRef = useAutoGrow(body);

  function applyLead(next) {
    const letter = letterOf(next);

    setLead(next);
    setSubject(letter.subject);
    setBody(letter.body);
    setDirty(false);
  }

  useEffect(() => {
    let active = true;

    setState('loading');
    api
      .get(`/leads/${encodeURIComponent(leadId)}`)
      .then((payload) => {
        if (!active) return;
        applyLead(payload?.lead ?? null);
        setError(null);
        setState('ready');
      })
      .catch((err) => {
        if (!active) return;
        setState(err?.status === NOT_FOUND ? 'missing' : 'error');
        if (err?.status !== NOT_FOUND) setError(err.message);
      });

    return () => {
      active = false;
    };
  }, [leadId]);

  /** One PATCH or POST, then re-read every field from what the server stored. */
  async function submit(request) {
    setBusy(true);
    setError(null);

    try {
      const payload = await request();

      // Only ever from what the server stored — never from what we hoped it did.
      if (payload?.lead) applyLead(payload.lead);
      if (typeof onChanged === 'function') onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function saveEdits() {
    return submit(() => api.patch(`/leads/${encodeURIComponent(leadId)}`, { subject, body }));
  }

  /**
   * Unsaved words are approved in the same request that approves them, so the
   * letter on screen and the letter approved are never two different letters.
   */
  function approve() {
    const patch = dirty ? { subject, body, approve: true } : { approve: true };

    return submit(() => api.patch(`/leads/${encodeURIComponent(leadId)}`, patch));
  }

  function redraft() {
    return submit(() => api.post(`/leads/${encodeURIComponent(leadId)}/regenerate`, {}));
  }

  if (state === 'loading') return <p className="muted thread-note">Fetching the letter…</p>;

  if (state === 'missing') {
    return <p className="muted thread-note">That recipient isn&apos;t in your roll.</p>;
  }

  if (state === 'error') {
    return (
      <p className="msg error" role="alert">
        {error}
      </p>
    );
  }

  const status = textOf(lead?.status) || 'pending';
  const scored = typeof lead?.fidelity_score === 'number';
  const lowFidelity = scored && lead.fidelity_score < LOW_FIDELITY;
  const open = OPEN_STATUSES.includes(status);
  const approved = status === 'approved';
  const written = subject.trim() !== '' && body.trim() !== '';
  const canEdit = open && !busy;
  const canApprove = open && written && !busy && (!approved || dirty);

  return (
    <section className="review" aria-label="Letter review">
      <div className="rowline letter-head">
        <div className="kicker red">The letter</div>
        {scored ? (
          <span className={lowFidelity ? 'tag red' : 'tag'}>
            <Icon name={lowFidelity ? 'triangle-alert' : 'check'} />
            {lowFidelity ? 'low fidelity — read closely' : 'sounds like you'}
          </span>
        ) : null}
      </div>

      <p className="mono review-meta">
        {`${status} · fidelity ${scored ? `${lead.fidelity_score}/100` : 'not scored'}`}
      </p>

      <div className="sheet">
        <div className="letterhead">
          <span className="lh-name">{`To ${fullName(lead) || textOf(lead?.email)}`}</span>
          <span className="mono faint">{textOf(lead?.email)}</span>
        </div>

        <div className="sheet-subject">
          <input
            className="rinput subject-input"
            type="text"
            aria-label="Subject"
            value={subject}
            disabled={!canEdit}
            onChange={(event) => {
              setSubject(event.target.value);
              setDirty(true);
            }}
          />
        </div>

        <textarea
          ref={bodyRef}
          className="rtext body-input"
          rows={11}
          aria-label="Email body"
          value={body}
          disabled={!canEdit}
          onChange={(event) => {
            setBody(event.target.value);
            setDirty(true);
          }}
        />
      </div>

      {lowFidelity ? (
        <p className="muted review-note">
          This draft scored under {LOW_FIDELITY}. Read every line before you approve it — or redraft
          it and read that instead.
        </p>
      ) : null}

      {approved && !dirty ? (
        <p className="tick review-approved" role="status">
          <Icon name="check" />
          Approved — this letter may be sent.
        </p>
      ) : null}

      <div className="rowline review-actions">
        <button type="button" className="btn red" onClick={approve} disabled={!canApprove}>
          <Icon name="stamp" />
          {approved && !dirty ? 'Approved' : 'Approve this letter'}
        </button>

        <button
          type="button"
          className="btn plain"
          onClick={saveEdits}
          disabled={!canEdit || !dirty || !written}
        >
          <Icon name="pen-line" />
          Save edits
        </button>

        <button type="button" className="btn plain" onClick={redraft} disabled={busy}>
          <Icon name={busy ? 'loader' : 'rotate-cw'} />
          Redraft
        </button>

        <button type="button" className="linkbtn" onClick={onClose}>
          Close
        </button>
      </div>

      {error ? (
        <p className="msg error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
