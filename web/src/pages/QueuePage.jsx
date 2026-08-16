import { useCallback, useEffect, useState } from 'react';

import ReviewDeck from '../components/ReviewDeck.jsx';
import RejectReasonDialog from '../components/RejectReasonDialog.jsx';
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
          No letters are ready for review. Unique only queues a lead when it clears every check —
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
        Drafted overnight, in your voice. Nothing has been sent — read each one, edit anything, and
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
        />
      )}

      {error ? (
        <p className="msg error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
