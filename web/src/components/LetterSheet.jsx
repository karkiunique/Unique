import { useEffect } from 'react';

import { fullName, textOf } from '../lib/letter.js';
import { useAutoGrow } from '../lib/useAutoGrow.js';

/**
 * The letter itself: who it is to, its subject, its body.
 *
 * Shared by the single-letter reviewer and the deck so both show the same fields
 * under the same labels. What is on this sheet is exactly what would be sent —
 * the edit, when there is one, not the draft underneath it.
 */

export default function LetterSheet({
  lead,
  subject,
  body,
  onSubjectChange,
  onBodyChange,
  disabled,
  focusBody
}) {
  const bodyRef = useAutoGrow(body);

  // Asking to edit puts the caret in the body. WHY: in the deck, E sits one key
  // from Enter, and a reviewer who asked to edit must land inside a field — where
  // Enter is a newline — rather than one keystroke away from approving.
  useEffect(() => {
    if (focusBody && !disabled) bodyRef.current?.focus();
  }, [focusBody, disabled, bodyRef]);

  return (
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
          disabled={disabled}
          onChange={(event) => onSubjectChange(event.target.value)}
        />
      </div>

      <textarea
        ref={bodyRef}
        className="rtext body-input"
        rows={11}
        aria-label="Email body"
        value={body}
        disabled={disabled}
        onChange={(event) => onBodyChange(event.target.value)}
      />
    </div>
  );
}
