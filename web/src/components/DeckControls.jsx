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
  canApprove,
  canEdit,
  canSave,
  canRedraft,
  busy,
  atFirst,
  atLast
}) {
  return (
    <div>
      <div className="rowline review-actions">
        <button type="button" className="btn red" onClick={onApprove} disabled={!canApprove}>
          <Icon name="stamp" />
          Approve &amp; next
        </button>

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

        <button type="button" className="linkbtn" onClick={onClose}>
          Close
        </button>
      </div>

      <ul className="deck-legend" aria-label="Keyboard shortcuts">
        <li>
          <kbd>Enter</kbd> approve &amp; next
        </li>
        <li>
          <kbd>←</kbd> <kbd>→</kbd> move without approving
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
