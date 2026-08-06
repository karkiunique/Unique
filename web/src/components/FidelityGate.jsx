import Icon from './Icon.jsx';

/**
 * The fidelity floor, stated where the user is standing.
 *
 * 80 is a floor in the compose flow, not a warning (CLAUDE.md §3): the letter
 * goes out under the user's own name on one click, so a draft that does not
 * sound like them never reaches the send button.
 *
 * A block that only says "no" is a dead end, so the way out sits in the same
 * box: regenerate here, or edit the letter — the first keystroke of their own
 * lifts the gate.
 */
export default function FidelityGate({ score, busy, canRegenerate, onRegenerate }) {
  return (
    <div className="gate" role="alert">
      <p className="msg error gate-msg">
        This does not sound enough like you — {score}/100, under the floor of 80. It does not go to
        the confirmation step as it stands.
      </p>
      <p className="gate-note">
        Draft it again, or edit it yourself — the moment the words are yours, the block lifts.
      </p>
      <button
        type="button"
        className="btn red gate-cta"
        onClick={onRegenerate}
        disabled={!canRegenerate}
      >
        <Icon name={busy ? 'loader' : 'feather'} />
        {busy ? 'Writing in your hand…' : 'Regenerate'}
      </button>
    </div>
  );
}
