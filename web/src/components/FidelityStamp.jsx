/**
 * The voice-fidelity stamp in the page head.
 *
 * Three states, because the number alone cannot say whether it still applies:
 *  - passing (>= 80): the draft sounds like them, nothing is in the way;
 *  - blocked (< 80): the draft cannot reach the confirmation step as it stands;
 *  - stale: the user edited the words, so the score describes text that is no
 *    longer on the page. Struck through rather than shown as a live number — a
 *    score that no longer describes the letter is worse than no score at all.
 */
export default function FidelityStamp({ score, stale, blocked }) {
  if (stale) {
    return (
      <div className="block pop fidelity stale" data-fidelity="stale">
        <div className="kicker">Voice fidelity</div>
        <div className="fidelity-score">
          <s>{score}</s>
        </div>
        <div className="kicker fidelity-note">Stale — your words now</div>
      </div>
    );
  }

  return (
    <div
      className={blocked ? 'block pop fidelity low' : 'block pop fidelity'}
      data-fidelity={blocked ? 'blocked' : 'passing'}
    >
      <div className="kicker">Voice fidelity</div>
      <div className="fidelity-score">
        {score}
        <span className="mono fidelity-out">/100</span>
      </div>
      {blocked ? <div className="kicker fidelity-note">Below the floor of 80</div> : null}
    </div>
  );
}
