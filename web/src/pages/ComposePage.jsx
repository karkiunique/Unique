import { useState } from 'react';

import ConfirmSendDialog from '../components/ConfirmSendDialog.jsx';
import ErrorNotice from '../components/ErrorNotice.jsx';
import FidelityGate from '../components/FidelityGate.jsx';
import FidelityStamp from '../components/FidelityStamp.jsx';
import Icon from '../components/Icon.jsx';
import RecipientFlag from '../components/RecipientFlag.jsx';
import { PageHead } from '../components/Shell.jsx';
import { api } from '../lib/api.js';
import { useAutoGrow } from '../lib/useAutoGrow.js';
import { useRecipientCheck } from '../lib/useRecipientCheck.js';

/**
 * Section II — compose one letter to one recipient.
 *
 * Generation is optional on purpose: the user can write the whole thing by hand,
 * or draft and then edit freely. Whatever ends up in the fields is what the
 * confirmation step shows, and what the confirmation step shows is what is sent.
 *
 * This page never calls POST /send. Sending happens only from ConfirmSendDialog,
 * after an explicit click, and the server re-checks the confirmation anyway.
 */

const LOW_FIDELITY = 80;

export default function ComposePage() {
  const [to, setTo] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [company, setCompany] = useState('');
  const [goal, setGoal] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [fidelityScore, setFidelityScore] = useState(null);
  // The score describes what the model wrote. The moment the user changes those
  // words it describes nothing, and the gate below lifts with it.
  const [edited, setEdited] = useState(false);
  const [violations, setViolations] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // The recovery code the server sent with the failure, if any.
  const [errorAction, setErrorAction] = useState(null);
  const [confirming, setConfirming] = useState(false);
  // Advisory only — deliberately absent from `canReview` below.
  const recipientCheck = useRecipientCheck();
  const goalRef = useAutoGrow(goal);

  function changeRecipient(value) {
    setTo(value);
    // Nothing we knew about the old address applies to this one.
    recipientCheck.forget(value);
  }

  /** Manual edits to the letter — the point at which the score goes stale. */
  function editSubject(value) {
    setSubject(value);
    setEdited(true);
  }

  function editBody(value) {
    setBody(value);
    setEdited(true);
  }

  async function generate() {
    setError(null);
    setErrorAction(null);
    setBusy(true);
    try {
      const payload = await api.post('/send/generate', {
        to: to.trim(),
        recipientName: recipientName.trim(),
        company: company.trim(),
        goal: goal.trim()
      });

      setSubject(typeof payload?.subject === 'string' ? payload.subject : '');
      setBody(typeof payload?.body === 'string' ? payload.body : '');
      setFidelityScore(typeof payload?.fidelityScore === 'number' ? payload.fidelityScore : null);
      setViolations(Array.isArray(payload?.violations) ? payload.violations : []);
      // Fresh model words: the score describes them again.
      setEdited(false);
    } catch (err) {
      setError(err.message);
      setErrorAction(err.action ?? null);
    } finally {
      setBusy(false);
    }
  }

  /** "Write another": a clean desk, so the last letter cannot be sent twice. */
  function reset() {
    setTo('');
    setRecipientName('');
    setCompany('');
    setGoal('');
    setSubject('');
    setBody('');
    setFidelityScore(null);
    setEdited(false);
    setViolations([]);
    setError(null);
    setErrorAction(null);
    setConfirming(false);
    recipientCheck.reset();
  }

  const recipient = to.trim();
  const addressee = recipientName.trim() || recipient;
  const canGenerate = recipient !== '' && goal.trim() !== '' && !busy;
  const scored = typeof fidelityScore === 'number';
  const lowFidelity = scored && fidelityScore < LOW_FIDELITY;
  /**
   * 80 is a floor here, not a warning (CLAUDE.md §3): one click sends this under
   * the user's own name. Only a GENERATED, untouched draft is gated — a
   * hand-written letter has no score to gate on, and once the user edits the
   * words they are the author, so the block lifts rather than trapping them
   * behind a number the model may never reach.
   */
  const blocked = lowFidelity && !edited;
  const canReview =
    recipient !== '' && subject.trim() !== '' && body.trim() !== '' && !busy && !blocked;

  return (
    <>
      <PageHead
        kicker="Section II"
        title={
          <>
            Compose <em>one</em> letter.
          </>
        }
        sub="One recipient, in your voice. You read the exact words before it ships."
        aside={
          scored ? <FidelityStamp score={fidelityScore} stale={edited} blocked={blocked} /> : null
        }
      />

      <div className="compose">
        <div>
          <div className="kicker red">The brief</div>

          <div className="rfield">
            <label htmlFor="to">To — email</label>
            <input
              id="to"
              className="rinput"
              type="email"
              value={to}
              onChange={(event) => changeRecipient(event.target.value)}
              onBlur={() => recipientCheck.check(to)}
              placeholder="sam@company.com"
            />
            {/* Under the To field, so a bad address is seen here and not at the
                confirmation step, three decisions later. */}
            <RecipientFlag
              checking={recipientCheck.checking}
              verification={recipientCheck.verification}
            />
          </div>

          <div className="brief-row">
            <div className="rfield">
              <label htmlFor="recipientName">Name</label>
              <input
                id="recipientName"
                className="rinput"
                type="text"
                value={recipientName}
                onChange={(event) => setRecipientName(event.target.value)}
                placeholder="Sam"
              />
            </div>
            <div className="rfield">
              <label htmlFor="company">Company</label>
              <input
                id="company"
                className="rinput"
                type="text"
                value={company}
                onChange={(event) => setCompany(event.target.value)}
                placeholder="Acme"
              />
            </div>
          </div>

          <div className="rfield">
            <label htmlFor="goal">What should it do?</label>
            {/* Grows with the brief: the more the user says here, the better the
                draft, so the box must not punish them for saying it. */}
            <textarea
              id="goal"
              ref={goalRef}
              className="rtext goal-input"
              rows={2}
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="ask for 15 minutes to show the demo"
            />
          </div>

          <button
            type="button"
            className="btn red block brief-cta"
            onClick={generate}
            disabled={!canGenerate}
          >
            <Icon name={busy ? 'loader' : 'feather'} />
            {busy ? 'Writing in your hand…' : 'Draft in my voice'}
          </button>

          <ErrorNotice message={error} action={errorAction} />

          {violations.length > 0 ? (
            <div className="violations">
              <div className="kicker red">House rules this draft bent</div>
              <ul className="violation-list">
                {violations.map((violation, index) => (
                  <li key={`${violation}-${index}`} className="violation">
                    {violation}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <div>
          <div className="rowline letter-head">
            <div className="kicker">The letter</div>
            {scored ? (
              <span className={lowFidelity ? 'tag red' : 'tag'}>
                <Icon name={lowFidelity ? 'triangle-alert' : 'check'} />
                {lowFidelity ? 'read closely' : 'sounds like you'}
              </span>
            ) : null}
          </div>

          <div className="sheet">
            <div className="letterhead">
              <span className="lh-name">{addressee ? `To ${addressee}` : 'To —'}</span>
              <span className="mono faint">{recipient}</span>
            </div>

            <div className="sheet-subject">
              <input
                className="rinput subject-input"
                type="text"
                aria-label="Subject"
                value={subject}
                onChange={(event) => editSubject(event.target.value)}
                placeholder="Re: — your subject line"
              />
            </div>

            <textarea
              className="rtext body-input"
              rows={11}
              aria-label="Email body"
              value={body}
              onChange={(event) => editBody(event.target.value)}
              placeholder="Draft in your voice, or write it yourself. The letter appears here — fully yours to edit."
            />
          </div>

          {blocked ? (
            <FidelityGate
              score={fidelityScore}
              busy={busy}
              canRegenerate={canGenerate}
              onRegenerate={generate}
            />
          ) : null}

          <button
            type="button"
            className="btn block review-btn"
            onClick={() => setConfirming(true)}
            disabled={!canReview}
          >
            <Icon name="stamp" />
            Review &amp; send
          </button>
        </div>
      </div>

      {confirming ? (
        <ConfirmSendDialog
          to={recipient}
          recipientName={recipientName.trim()}
          subject={subject}
          body={body}
          onCancel={() => setConfirming(false)}
          onWriteAnother={reset}
        />
      ) : null}
    </>
  );
}
