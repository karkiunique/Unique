import { useState } from 'react';

import ConfirmSendDialog from '../components/ConfirmSendDialog.jsx';
import { api } from '../lib/api.js';

/**
 * Compose one email to one recipient.
 *
 * Generation is optional on purpose: the user can write the whole thing by hand,
 * or generate and then edit freely. Whatever ends up in the fields is what the
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
  const [violations, setViolations] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);

  async function generate() {
    setError(null);
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
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const recipient = to.trim();
  const canGenerate = recipient !== '' && goal.trim() !== '' && !busy;
  const canReview = recipient !== '' && subject.trim() !== '' && body.trim() !== '' && !busy;
  const lowFidelity = typeof fidelityScore === 'number' && fidelityScore < LOW_FIDELITY;

  if (confirming) {
    return (
      <main className="shell top">
        <div className="card wide">
          <h1>Review and send</h1>
          <ConfirmSendDialog
            to={recipient}
            subject={subject}
            body={body}
            onCancel={() => setConfirming(false)}
          />
        </div>
      </main>
    );
  }

  return (
    <main className="shell top">
      <div className="card wide">
        <h1>Compose</h1>
        <p className="muted">
          One email, one recipient, in your voice. You review the exact text before anything is
          sent.
        </p>

        <label htmlFor="to">Recipient email</label>
        <input
          id="to"
          type="email"
          value={to}
          onChange={(event) => setTo(event.target.value)}
          placeholder="sam@company.com"
        />

        <label htmlFor="recipientName">Recipient name</label>
        <input
          id="recipientName"
          type="text"
          value={recipientName}
          onChange={(event) => setRecipientName(event.target.value)}
          placeholder="Sam Rivera"
        />

        <label htmlFor="company">Company</label>
        <input
          id="company"
          type="text"
          value={company}
          onChange={(event) => setCompany(event.target.value)}
          placeholder="Acme"
        />

        <label htmlFor="goal">What should this email do?</label>
        <input
          id="goal"
          type="text"
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          placeholder="ask for 15 minutes to show the demo"
        />

        <button type="button" onClick={generate} disabled={!canGenerate}>
          {busy ? 'Writing…' : 'Generate in my voice'}
        </button>

        {typeof fidelityScore === 'number' ? (
          <p className={lowFidelity ? 'error' : 'notice'}>
            Voice fidelity {fidelityScore} / 100
            {lowFidelity ? ' — this does not sound enough like you. Read it closely before sending.' : ''}
          </p>
        ) : null}

        {violations.length > 0 ? (
          <ul className="chips">
            {violations.map((violation, index) => (
              <li key={`${violation}-${index}`} className="chip suspect-chip">
                {violation}
              </li>
            ))}
          </ul>
        ) : null}

        <label htmlFor="subject">Subject</label>
        <input
          id="subject"
          type="text"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          placeholder="Write it yourself, or generate above"
        />

        <label htmlFor="body">Email body</label>
        <textarea
          id="body"
          rows={14}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Write it yourself, or generate above"
        />

        {error ? <p className="error">{error}</p> : null}

        <button type="button" onClick={() => setConfirming(true)} disabled={!canReview}>
          Review and send
        </button>
      </div>
    </main>
  );
}
