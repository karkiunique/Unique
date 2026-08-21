import { useCallback, useEffect, useState } from 'react';

import ReviewDeck from '../components/ReviewDeck.jsx';
import RejectReasonDialog from '../components/RejectReasonDialog.jsx';
import ConfirmSendDialog from '../components/ConfirmSendDialog.jsx';
import ErrorNotice from '../components/ErrorNotice.jsx';
import { api } from '../lib/api.js';
import { navigateTo } from '../lib/navigate.js';

/**
 * The daily review queue (CLAUDE.md, Decisions 2026-08-16).
 *
 * What the overnight job drafted, waiting for a human. Nothing here has been
 * sent, and nothing here sends itself: approval is still one explicit action per
 * letter through `PATCH /leads/:id`, exactly as the campaign deck does it.
 *
 * The deck is reused rather than reimplemented — same keyboard, same per-letter
 * gate, same "never act on a letter that is not on screen" rule. The only thing
 * this screen adds is the rejection path, because a lead the JOB chose has
 * targeting to teach, where a lead the user uploaded has none.
 */

export default function QueuePage() {
  const [leads, setLeads] = useState([]);
  const [state, setState] = useState('loading');
  const [error, setError] = useState(null);

  // The lead the deck is asking us to reject; null when the dialog is closed.
  const [rejecting, setRejecting] = useState(null);
  const [rejectBusy, setRejectBusy] = useState(false);

  // The letter being confirmed for sending: {id, to, subject, body}. Held whole
  // rather than by id, because what the confirmation shows must be exactly what
  // was on screen — re-fetching here would let a different letter be sent than
  // the one the person just read.
  const [sending, setSending] = useState(null);
  const [sendPrep, setSendPrep] = useState(null);

  const load = useCallback(async () => {
    try {
      const payload = await api.get('/queue');
      setLeads(Array.isArray(payload?.leads) ? payload.leads : []);
      setState('ready');
    } catch (err) {
      setError(err?.message || 'Could not load your queue.');
      setState('error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Drop the letter locally as well as on the server.
   *
   * The deck is driven by this list, so removing the row is what advances it —
   * and it means a rejected letter cannot be approved by a stray Enter while the
   * refetch is in flight.
   */
  async function handleReject(reason, note) {
    if (!rejecting) return;

    setRejectBusy(true);
    try {
      await api.post(`/leads/${rejecting}/reject`, { reason, note });
      setLeads((current) => current.filter((lead) => lead.id !== rejecting));
      setRejecting(null);
    } catch (err) {
      setError(err?.message || 'Could not record that.');
    } finally {
      setRejectBusy(false);
    }
  }

  /**
   * Open the confirmation for one letter.
   *
   * Approval happens HERE, before the dialog, rather than as a separate button:
   * the server requires `approved` (2026-08-08) and the human's explicit action is
   * confirming the exact letter, which is the stronger of the two. If approval
   * fails nothing is shown and nothing is sent.
   */
  async function beginSend(letter) {
    const lead = leads.find((row) => row.id === letter.id);
    if (!lead) return;

    setSendPrep(letter.id);
    setError(null);
    try {
      await api.patch(`/leads/${letter.id}`, { approve: true });
      setSending({ id: letter.id, to: lead.email, subject: letter.subject, body: letter.body });
    } catch (err) {
      setError(err?.message || 'Could not prepare that letter for sending.');
    } finally {
      setSendPrep(null);
    }
  }

  /** Sent for real. Drop it from the queue — it is no longer awaiting anything. */
  function handleSent() {
    setLeads((current) => current.filter((lead) => lead.id !== sending?.id));
    setSending(null);
  }

  if (state === 'loading') {
    return (
      <div className="daily">
        <p className="muted">Fetching your queue…</p>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="daily">
        <ErrorNotice message={error} onRetry={load} />
      </div>
    );
  }

  if (leads.length === 0) {
    return (
      <div className="daily">
        <div className="kicker red">The daily queue</div>
        <h1>Nothing waiting.</h1>
        <p className="lead">
          No letters are ready for review. Unique only queues a lead when it clears every check:
          a deliverable address, a real match to your target, and something specific to say. A quiet
          day means nothing was good enough, which is the point.
        </p>
        <button type="button" className="linkbtn" onClick={() => navigateTo('/target')}>
          Review your target →
        </button>
      </div>
    );
  }

  return (
    <div className="daily">
      <div className="rowline">
        <div>
          <div className="kicker red">The daily queue</div>
          <h1>{leads.length === 1 ? '1 letter' : `${leads.length} letters`} to review</h1>
        </div>
        <button type="button" className="linkbtn" onClick={() => navigateTo('/target')}>
          Your target →
        </button>
      </div>

      <p className="lead">
        Drafted overnight, in your voice. Nothing has been sent. Read each one, edit anything, and
        send the ones you want.
      </p>

      {rejecting ? (
        <RejectReasonDialog
          onSubmit={handleReject}
          onCancel={() => setRejecting(null)}
          busy={rejectBusy}
        />
      ) : (
        <ReviewDeck
          leads={leads}
          onClose={() => navigateTo('/')}
          onChanged={load}
          onReject={(leadId) => setRejecting(leadId)}
          onSend={beginSend}
        />
      )}

      {sendPrep ? <p className="muted">Getting the letter ready…</p> : null}

      {/* What this renders is what goes out: full recipient, subject and body, no
          summary. Nothing is re-fetched or re-generated between the reading and
          the sending. */}
      {sending ? (
        <ConfirmSendDialog
          leadId={sending.id}
          to={sending.to}
          subject={sending.subject}
          body={sending.body}
          doneLabel="Back to the queue"
          doneIcon="arrow-left"
          onCancel={() => setSending(null)}
          onSent={handleSent}
          onWriteAnother={handleSent}
        />
      ) : null}

      {error ? (
        <p className="msg error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
