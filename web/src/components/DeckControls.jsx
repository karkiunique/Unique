import Icon from './Icon.jsx';

/**
 * The deck's controls: the same moves the keyboard makes, as buttons, plus the
 * legend that says what those keys are.
 *
 * Every shortcut has a button here on purpose — a keyboard-only flow is a flow
 * that excludes anyone not using a keyboard, and an unwritten shortcut is one
 * nobody discovers. The deck itself decides what may be approved; this file only
 * draws the choices.
 */

export default function DeckControls({
  onApprove,
  onMove,
  onEdit,
  onSave,
  onRedraft,
  onClose,
  onReject,
  onSend,
  canApprove,
  canEdit,
  canSave,
  canRedraft,
  canReject,
  canSend,
  busy,
  atFirst,
  atLast
}) {
  return (
    <div>
      <div className="rowline review-actions">
        {/* Only the daily queue passes onSend. It leads the row because it is the
            action this screen exists for — and it is a CLICK, never a shortcut:
            approval is reversible and sending is not (Decisions, 2026-08-19). */}
        {typeof onSend === 'function' ? (
          <button type="button" className="btn red" onClick={onSend} disabled={!canSend}>
            <Icon name="send" />
            Send this letter
          </button>
        ) : (
          <button type="button" className="btn red" onClick={onApprove} disabled={!canApprove}>
            <Icon name="stamp" />
            Approve &amp; next
          </button>
        )}

        <button type="button" className="btn plain" onClick={() => onMove(-1)} disabled={atFirst}>
          <Icon name="arrow-left" />
          Previous
        </button>

        <button type="button" className="btn plain" onClick={() => onMove(1)} disabled={atLast}>
          <Icon name="arrow-right" />
          Next
        </button>

        <button type="button" className="btn plain" onClick={onEdit} disabled={!canEdit}>
          <Icon name="pen-line" />
          Edit
        </button>

        <button type="button" className="btn plain" onClick={onSave} disabled={!canSave}>
          <Icon name="check" />
          Save edits
        </button>

        <button type="button" className="btn plain" onClick={onRedraft} disabled={!canRedraft}>
          <Icon name={busy ? 'loader' : 'rotate-cw'} />
          Redraft
        </button>

        {/* Only the daily queue passes onReject: a campaign lead the user
            uploaded themselves has no targeting to teach. */}
        {typeof onReject === 'function' ? (
          <button type="button" className="btn plain" onClick={onReject} disabled={!canReject}>
            <Icon name="eye-off" />
            Not a fit
          </button>
        ) : null}

        <button type="button" className="linkbtn" onClick={onClose}>
          Close
        </button>
      </div>

      <ul className="deck-legend" aria-label="Keyboard shortcuts">
        {/* SEND HAS NO SHORTCUT, and this legend must never claim one. Approval is
            reversible; a send is not. */}
        {typeof onSend === 'function' ? null : (
          <li>
            <kbd>Enter</kbd> approve &amp; next
          </li>
        )}
        <li>
          <kbd>←</kbd> <kbd>→</kbd> {typeof onSend === 'function' ? 'move between letters' : 'move without approving'}
        </li>
        <li>
          <kbd>E</kbd> edit
        </li>
        <li>
          <kbd>Esc</kbd> back to the list
        </li>
      </ul>
    </div>
  );
}
