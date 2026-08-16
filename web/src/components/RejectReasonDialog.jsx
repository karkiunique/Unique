import { useState } from 'react';

import Icon from './Icon.jsx';

/**
 * Why this lead was not a fit.
 *
 * The reason is a CLOSED SET because it feeds targeting, and free text cannot be
 * aggregated into a signal. The note is optional and is for the user's own
 * benefit — it is stored but never used to steer anything automatically.
 *
 * This teaches WHO TO APPROACH. It must never be fed into the voice profile:
 * `learned_corrections` learns how the user writes and the adaptation loop learns
 * what gets replies. Three loops, three questions (CLAUDE.md, 2026-08-16).
 */

const REASONS = [
  ['wrong_role', 'Wrong role', 'Right company, wrong person.'],
  ['wrong_company', 'Wrong company', 'Not the kind of organisation I sell to.'],
  ['bad_timing', 'Bad timing', 'Right fit, wrong moment.'],
  ['weak_hook', 'Nothing to say', 'The research did not turn up a real reason to write.'],
  ['other', 'Something else', null]
];

const MAX_NOTE = 500;

export default function RejectReasonDialog({ onSubmit, onCancel, busy }) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');

  function handleSubmit(event) {
    event.preventDefault();
    if (reason === '') return;

    onSubmit(reason, note.trim() === '' ? null : note.trim());
  }

  return (
    <form className="reject-dialog" onSubmit={handleSubmit}>
      <div className="kicker red">Not a fit</div>
      <p className="muted">
        This letter will not be sent, and it comes out of your queue. Telling us why sharpens
        tomorrow&apos;s leads.
      </p>

      <fieldset className="reject-reasons">
        <legend className="visually-hidden">Why is this lead not a fit?</legend>

        {REASONS.map(([value, label, hint]) => (
          <label className="reject-reason" key={value}>
            <input
              type="radio"
              name="reject-reason"
              value={value}
              checked={reason === value}
              onChange={() => setReason(value)}
            />
            <span>
              <span className="reject-reason-label">{label}</span>
              {hint ? <span className="reject-reason-hint">{hint}</span> : null}
            </span>
          </label>
        ))}
      </fieldset>

      <label className="rfield">
        <span>Anything to add? (optional)</span>
        <textarea
          className="rinput"
          rows={2}
          maxLength={MAX_NOTE}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="only you will see this"
        />
      </label>

      <div className="rowline">
        <button type="submit" className="btn red" disabled={reason === '' || busy}>
          <Icon name={busy ? 'loader' : 'check'} />
          {busy ? 'Recording…' : 'Not a fit'}
        </button>
        <button type="button" className="linkbtn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
