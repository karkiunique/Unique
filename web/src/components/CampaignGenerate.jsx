import { useState } from 'react';

import Icon from './Icon.jsx';
import { api } from '../lib/api.js';

/**
 * "Draft the letters" — the campaign's batch generation, and the progress of a
 * run already under way.
 *
 * The counts are read off the leads the campaign detail already loaded, so this
 * component fetches nothing of its own and shows no letter: a recipient that has
 * been drafted for is one whose status has left `pending`, which is a status and
 * not a body. The letters themselves stay in the database until somebody opens
 * one on the review screen.
 *
 * Drafting is not sending. Every letter this produces still has to be read and
 * approved one at a time before it can go anywhere.
 */

const PENDING = 'pending';
const GENERATING = 'generating';
const SENDING = 'sending';

function leadsOf(campaign) {
  return Array.isArray(campaign?.leads) ? campaign.leads : [];
}

export default function CampaignGenerate({ campaign, onStarted }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const campaignId = typeof campaign?.id === 'string' ? campaign.id : '';
  const leads = leadsOf(campaign);
  const waiting = leads.filter((lead) => lead?.status === PENDING).length;
  const drafted = leads.length - waiting;
  const generating = campaign?.status === GENERATING;
  const sending = campaign?.status === SENDING;

  async function start() {
    setBusy(true);
    setError(null);

    try {
      await api.post(`/campaigns/${encodeURIComponent(campaignId)}/generate`, {});
      if (typeof onStarted === 'function') onStarted();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (leads.length === 0) return null;

  const percent = Math.round((drafted / leads.length) * 100);
  const canStart = campaignId !== '' && waiting > 0 && !generating && !sending && !busy;

  return (
    <section className="campgen">
      <div className="rowline campgen-head">
        <div className="kicker red">Draft the letters</div>
        <span className="mono campgen-count">
          {`${drafted} of ${leads.length} drafted · ${waiting} waiting`}
        </span>
      </div>

      {generating ? (
        <>
          <div className="campgen-bar" aria-hidden="true">
            <span className="campgen-fill" style={{ width: `${percent}%` }} />
          </div>
          <p className="mono campgen-progress" role="status">
            {`Writing in your hand — ${drafted} of ${leads.length} done…`}
          </p>
        </>
      ) : null}

      {!generating && waiting > 0 ? (
        <button type="button" className="btn red" onClick={start} disabled={!canStart}>
          <Icon name={busy ? 'loader' : 'feather'} />
          {busy ? 'Starting…' : `Draft ${waiting} ${waiting === 1 ? 'letter' : 'letters'}`}
        </button>
      ) : null}

      {!generating && waiting === 0 ? (
        <p className="muted campgen-done">Every recipient has a draft waiting to be read.</p>
      ) : null}

      <p className="muted campgen-note">
        Drafting is not sending. Each letter is read and approved on its own before anything leaves
        your Gmail.
      </p>

      {error ? (
        <p className="msg error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
