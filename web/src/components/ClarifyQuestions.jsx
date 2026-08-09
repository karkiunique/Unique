import { useState } from 'react';

import Icon from './Icon.jsx';
import { PageHead } from './Shell.jsx';
import { api } from '../lib/api.js';
import { useAutoGrow } from '../lib/useAutoGrow.js';

/**
 * The clarify pass, asked ONE QUESTION AT A TIME (CLAUDE.md, 2026-08-09).
 *
 * Eight boxes on one screen reads as a form to be filled in, and a form gets
 * abandoned. One question, a box, and two ways forward reads as a conversation.
 *
 * A SKIP IS A FIRST-CLASS OUTCOME. It is a real button, not a hidden one, and it
 * records the question with no answer rather than dropping it — what was asked
 * is worth keeping even when it went unanswered. Drafting is never blocked on a
 * question, so every path out of this component leads to the campaign.
 */

/** The forward button says where it goes: on to the next one, or out. */
function forwardButton(saving, isLast) {
  if (saving) return { icon: 'loader', label: 'Saving…' };
  if (isLast) return { icon: 'check', label: 'Done' };

  return { icon: 'arrow-right', label: 'Next' };
}

export default function ClarifyQuestions({ campaignId, questions, onDone }) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState([]);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const answerRef = useAutoGrow(text);

  const total = questions.length;
  const question = questions[index] ?? '';
  const isLast = index + 1 >= total;

  async function save(collected) {
    setSaving(true);
    setError(null);

    try {
      await api.patch(`/campaigns/${campaignId}`, { clarifications: collected });
      onDone();
    } catch (err) {
      // The campaign itself already exists and is perfectly usable, so this is a
      // lost answer, not a lost campaign — say so, and offer both ways out.
      setError(err.message);
      setSaving(false);
    }
  }

  /** `answer` is the user's own words, or null when they skipped. */
  async function record(answer) {
    const collected = [...answers, { question, answer }];

    setAnswers(collected);
    setText('');

    if (!isLast) {
      setIndex(index + 1);
      return;
    }

    await save(collected);
  }

  const written = text.trim();
  const forward = forwardButton(saving, isLast);

  return (
    <>
      <PageHead
        kicker="Section IV · New campaign"
        title={
          <>
            A few <em>questions</em>.
          </>
        }
        sub="What a cold email needs and your brief did not say. Skip anything you would rather not answer."
      />

      <div className="clarify">
        <div className="rowline clarify-head">
          <div className="kicker red">The brief, filled in</div>
          <span className="clarify-count">
            Question {index + 1} of {total}
          </span>
        </div>

        <p className="clarify-q">{question}</p>

        <div className="rfield">
          <label htmlFor="clarify-answer">Your answer</label>
          <textarea
            id="clarify-answer"
            ref={answerRef}
            className="rtext clarify-input"
            rows={3}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="As much or as little as you like."
          />
        </div>

        <div className="rowline clarify-actions">
          <button type="button" className="btn plain" onClick={() => record(null)} disabled={saving}>
            Skip
          </button>
          <button
            type="button"
            className="btn red"
            onClick={() => record(written)}
            disabled={saving || written === ''}
          >
            <Icon name={forward.icon} />
            {forward.label}
          </button>
        </div>

        <p className="muted clarify-note">
          Nothing here is required. Every answer is one more thing the letters can say instead of
          guessing.
        </p>

        {error ? (
          <div className="clarify-failed">
            <p className="msg error" role="alert">
              {error}
            </p>
            <div className="rowline clarify-actions">
              <button type="button" className="btn" onClick={() => save(answers)} disabled={saving}>
                <Icon name="rotate-cw" />
                Try again
              </button>
              <button type="button" className="btn plain" onClick={onDone}>
                Go to the campaign anyway
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
