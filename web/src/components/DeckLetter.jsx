import Icon from './Icon.jsx';
import LetterSheet from './LetterSheet.jsx';
import { isLowFidelity, LOW_FIDELITY, scoreOf, statusOf } from '../lib/letter.js';

/**
 * One card of the review deck: the letter as it would be sent, its score, and —
 * when it is the last one and it has been approved — the way back to the list,
 * so the deck ends somewhere rather than dead-ending on its final card.
 *
 * Split out of ReviewDeck to keep both files readable; the deck itself owns the
 * keyboard and the approval, which is where the guarantees live.
 */

export default function DeckLetter({ letter, editable, atLast, approvedCount, total, onClose }) {
  const status = statusOf(letter.lead);
  const score = scoreOf(letter.lead);
  const lowFidelity = isLowFidelity(letter.lead);
  const approved = status === 'approved';

  return (
    <div className="deck-letter">
      <p className="mono review-meta">
        {`${status} · fidelity ${score === null ? 'not scored' : `${score}/100`}`}
        {score === null ? null : (
          <span className={lowFidelity ? 'tag red deck-tag' : 'tag deck-tag'}>
            <Icon name={lowFidelity ? 'triangle-alert' : 'check'} />
            {lowFidelity ? 'low fidelity — read closely' : 'sounds like you'}
          </span>
        )}
      </p>

      <LetterSheet
        lead={letter.lead}
        subject={letter.subject}
        body={letter.body}
        onSubjectChange={letter.editSubject}
        onBodyChange={letter.editBody}
        disabled={!editable}
        focusBody={editable}
      />

      {lowFidelity ? (
        <p className="muted review-note">
          This draft scored under {LOW_FIDELITY}. Read every line before you approve it — or redraft
          it and read that instead.
        </p>
      ) : null}

      {approved && !letter.dirty ? (
        <p className="tick review-approved">
          <Icon name="check" />
          Approved — this letter may be sent.
        </p>
      ) : null}

      {atLast && approved ? (
        <div className="deck-done">
          <p className="deck-done-line">
            {approvedCount === total
              ? `That was the last letter — all ${total} approved.`
              : 'That was the last letter.'}
          </p>
          <button type="button" className="btn red" onClick={onClose}>
            <Icon name="arrow-left" />
            Back to the list
          </button>
        </div>
      ) : null}
    </div>
  );
}
