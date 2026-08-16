import { useEffect, useRef, useState } from 'react';

import DeckControls from './DeckControls.jsx';
import DeckLetter from './DeckLetter.jsx';
import { isOpenForReview, statusOf } from '../lib/letter.js';
import { useLetter } from '../lib/useLetter.js';

/**
 * The review deck: one letter fills the view, Enter approves it and moves on.
 *
 * Forty letters read through a click-in/click-out list is unbearable, so the
 * deck is dealt like cards — but it does NOT weaken the per-letter approval
 * gate, it tightens it (CLAUDE.md, 2026-08-09). Every letter is rendered in full
 * before it can be approved, every approval is still one explicit action against
 * one recipient through PATCH /leads/:id, and there is no Approve All.
 *
 * Three rules carry that guarantee:
 *   - nothing is approved that is not on screen — the letter must have loaded,
 *     and the id approved is the id of the letter being displayed;
 *   - a focused field owns the keyboard. While the reviewer is typing, Enter is
 *     a newline. Getting that wrong approves letters as somebody writes;
 *   - the shortcuts belong to the deck, not to the page. The deck renders inline
 *     beside the roll and the rest of the campaign screen, so a document-level
 *     listener would let Enter on some other control — the Generate button, say —
 *     both press that button and approve the letter behind it.
 *
 * Reading is not approving: the arrows move without sending anything.
 *
 * Bodies are email content — held for the letter on screen and never logged.
 */

/** Whether the keystroke belongs to a field the reviewer is typing in. */
function isEditableTarget(target) {
  const tag = typeof target?.tagName === 'string' ? target.tagName.toLowerCase() : '';

  return tag === 'textarea' || tag === 'input' || target?.isContentEditable === true;
}

function clampIndex(index, total) {
  if (index < 0) return 0;

  return index > total - 1 ? total - 1 : index;
}

export default function ReviewDeck({ leads, startLeadId, onClose, onChanged, onShown, onReject }) {
  const deck = Array.isArray(leads) ? leads.filter((lead) => typeof lead?.id === 'string') : [];
  const total = deck.length;

  const [index, setIndex] = useState(() => {
    const opened = deck.findIndex((lead) => lead.id === startLeadId);

    return opened === -1 ? 0 : opened;
  });
  const [editing, setEditing] = useState(false);
  // Approved in this sitting, so the running count is right before the campaign
  // list has been re-read.
  const [approvedIds, setApprovedIds] = useState(() => new Set());

  const position = clampIndex(index, total);
  const currentId = deck[position]?.id ?? '';

  const letter = useLetter(currentId, onChanged);
  const deckRef = useRef(null);

  const letterId = letter.lead?.id ?? '';
  const letterStatus = statusOf(letter.lead);

  // The list is told which letters have actually been shown: approval is
  // per-letter, and a reviewer needs to see where they got to.
  useEffect(() => {
    if (currentId !== '' && typeof onShown === 'function') onShown(currentId);
  }, [currentId, onShown]);

  // The running count follows the server's answer for the open letter in both
  // directions — an edit withdraws approval, and the count must show that.
  useEffect(() => {
    if (letterId === '') return;

    setApprovedIds((current) => {
      const approved = letterStatus === 'approved';
      if (current.has(letterId) === approved) return current;

      const next = new Set(current);
      if (approved) next.add(letterId);
      else next.delete(letterId);

      return next;
    });
  }, [letterId, letterStatus]);

  // The shortcuts are bound to the deck itself, so the deck must hold the focus:
  // on open, on every new letter, and again whenever the reviewer stops typing or
  // clicks a button. Without this the keyboard would be dead until someone
  // clicked into the deck.
  useEffect(() => {
    if (!editing) deckRef.current?.focus();
  }, [currentId, editing]);

  const ready = letter.state === 'ready';
  // The loaded letter must BE the card on screen. For the render between
  // advancing and the next letter arriving the hook still holds the previous
  // one, and acting there would approve — or redraft — the wrong recipient.
  const showing = ready && letterId === currentId;
  const written = letter.subject.trim() !== '' && letter.body.trim() !== '';
  const canEdit = showing && isOpenForReview(letter.lead) && !letter.busy;
  // An already-approved letter may be approved again — the server treats
  // approved -> approved as legal — so a second pass never stalls the deck.
  const canApprove = canEdit && written;
  const atLast = position === total - 1;
  const approvedCount = deck.filter(
    (lead) => approvedIds.has(lead.id) || statusOf(lead) === 'approved'
  ).length;

  function moveBy(step) {
    setEditing(false);
    setIndex((at) => clampIndex(at + step, total));
  }

  async function approveAndAdvance() {
    if (!canApprove) return;

    const stored = await letter.approve();
    // Only a letter the server actually stored moves the deck on.
    if (stored) moveBy(1);
  }

  function handleKey(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const inField = isEditableTarget(event.target);

    if (event.key === 'Escape') {
      event.preventDefault();
      // Esc leaves the field before it leaves the deck: a reviewer mid-sentence
      // gets out of edit mode, not out of the screen with the edit unsaved.
      if (inField) {
        if (typeof event.target.blur === 'function') event.target.blur();
        setEditing(false);
        return;
      }
      if (typeof onClose === 'function') onClose();
      return;
    }

    // A FOCUSED FIELD OWNS EVERY OTHER KEY. Enter inside one inserts a newline
    // and the arrows move the caret. Without this line, typing approves letters.
    if (inField) return;

    if (event.key === 'Enter') {
      event.preventDefault();
      approveAndAdvance();
      return;
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      moveBy(1);
      return;
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      moveBy(-1);
      return;
    }

    if (event.key === 'e' || event.key === 'E') {
      event.preventDefault();
      if (canEdit) setEditing(true);
    }
  }

  if (total === 0) {
    return (
      <section
        className="deck"
        role="region"
        aria-label="Review deck"
        tabIndex={-1}
        ref={deckRef}
        onKeyDown={handleKey}
      >
        <div className="deck-inner">
          <p className="muted thread-note">No letters to review yet.</p>
          <button type="button" className="linkbtn" onClick={onClose}>
            Back to the list
          </button>
        </div>
      </section>
    );
  }

  return (
    // Bound here rather than on document: the handler is always this render's
    // closure, and a keystroke aimed at anything outside the deck is not ours.
    <section
      className="deck"
      role="region"
      aria-label="Review deck"
      tabIndex={-1}
      ref={deckRef}
      onKeyDown={handleKey}
    >
      <div className="deck-inner">
        <div className="rowline deck-head">
          <div className="kicker red">The letter</div>
          <div className="deck-marks">
            <span className="mono deck-position">{`Letter ${position + 1} of ${total}`}</span>
            <span className="mono deck-approved">{`${approvedCount} approved`}</span>
          </div>
        </div>

        {letter.state === 'loading' ? (
          <p className="muted thread-note">Fetching the letter…</p>
        ) : null}

        {letter.state === 'missing' ? (
          <p className="muted thread-note">That recipient isn&apos;t in your roll.</p>
        ) : null}

        {letter.state === 'error' ? (
          <p className="msg error" role="alert">
            {letter.error}
          </p>
        ) : null}

        {ready ? (
          <DeckLetter
            letter={letter}
            editable={canEdit && editing}
            atLast={atLast}
            approvedCount={approvedCount}
            total={total}
            onClose={onClose}
          />
        ) : null}

        <DeckControls
          onApprove={approveAndAdvance}
          onMove={moveBy}
          onEdit={() => setEditing(true)}
          onSave={letter.saveEdits}
          onRedraft={letter.redraft}
          onClose={onClose}
          // Optional, and passed the id of the letter ON SCREEN — the same rule
          // that governs approval: never act on a letter that is not displayed.
          onReject={typeof onReject === 'function' ? () => onReject(currentId) : undefined}
          canApprove={canApprove}
          canEdit={canEdit && !editing}
          canSave={canEdit && letter.dirty && written}
          canRedraft={showing && !letter.busy}
          canReject={showing && !letter.busy}
          busy={letter.busy}
          atFirst={position === 0}
          atLast={atLast}
        />

        {ready && letter.error ? (
          <p className="msg error" role="alert">
            {letter.error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
