import { useEffect, useState } from 'react';

import CampaignGenerate from './CampaignGenerate.jsx';
import Icon from './Icon.jsx';
import LeadReview from './LeadReview.jsx';
import { PageHead } from './Shell.jsx';
import CampaignLeadsPage from '../pages/CampaignLeadsPage.jsx';
import { api } from '../lib/api.js';
import { navigateTo } from '../lib/navigate.js';

/**
 * One campaign: its recipients, their drafting progress, and the review screen
 * for whichever letter is open.
 *
 * The list carries names, addresses and statuses — never a letter. A body is
 * fetched only when a recipient is actually opened, one at a time, by LeadReview.
 *
 * WHICH LETTERS HAVE BEEN READ IS SHOWN, because approval is per-letter and a
 * reviewer working down a list needs to see where they got to. It is a reading
 * aid and nothing more: the server decides what may be approved, and it will
 * refuse a recipient with no draft whatever this screen has marked.
 *
 * A campaign that is not the caller's comes back 404 from the server, and reads
 * here as "not in your roll" rather than as a fault.
 */

const NOT_FOUND = 404;
const MODE_LABELS = { voice: 'Voice', template: 'Template' };
const LOW_FIDELITY = 80;

/** How often a run under way is re-read. Polling stops when it leaves 'generating'. */
const POLL_MS = 2500;

function tally(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** '' for anything that is not one of the two modes — never a raw lookup result. */
function modeLabel(mode) {
  const label = MODE_LABELS[mode];

  return typeof label === 'string' ? label : '';
}

function fullName(lead) {
  return [lead?.first_name, lead?.last_name]
    .filter((part) => typeof part === 'string' && part.trim() !== '')
    .join(' ');
}

/**
 * One recipient's line. A button, like the register's rows: the whole line opens
 * the letter, so the hit target is the line the eye is already on.
 *
 * The read mark says whether this reviewer has opened this letter — the one
 * thing a list of forty drafts cannot otherwise tell them.
 */
function LeadRow({ lead, position, read, onOpen }) {
  const status = typeof lead?.status === 'string' ? lead.status : 'pending';
  const score = typeof lead?.fidelity_score === 'number' ? lead.fidelity_score : null;
  const lowFidelity = score !== null && score < LOW_FIDELITY;

  return (
    <button type="button" className="reg-row" onClick={() => onOpen(lead?.id)}>
      <span className="reg-no">{String(position + 1).padStart(2, '0')}</span>

      <span className="reg-subject">
        <span className="t">{fullName(lead) || lead?.email || 'Unknown'}</span>
        <span className="a">{lead?.email ?? ''}</span>
      </span>

      <span className="reg-sent">
        {lead?.company ?? ''}
        {lowFidelity ? <span className="lead-lowfi">low fidelity</span> : null}
      </span>

      <span className="reg-status lead-status">
        <span className="camp-status">{status}</span>
        <span className={read ? 'lead-read' : 'lead-read unread'}>{read ? 'read' : 'unread'}</span>
      </span>
    </button>
  );
}

function BackToRoll() {
  return (
    <button type="button" className="linkbtn thread-back" onClick={() => navigateTo('/campaigns')}>
      <Icon name="arrow-left" />
      Back to the roll
    </button>
  );
}

export default function CampaignDetail({ campaignId }) {
  const [campaign, setCampaign] = useState(null);
  // 'loading' | 'ready' | 'missing' | 'error'
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);
  // Bumped after recipients are added, to re-read the campaign. Starts at 0 so
  // the mount still costs exactly one fetch.
  const [reloadToken, setReloadToken] = useState(0);
  const [openLeadId, setOpenLeadId] = useState(null);
  // Which letters this reviewer has actually opened, this visit.
  const [readLeadIds, setReadLeadIds] = useState(() => new Set());

  function reload() {
    setReloadToken((token) => token + 1);
  }

  function openLead(leadId) {
    if (typeof leadId !== 'string' || leadId === '') return;

    setOpenLeadId(leadId);
    setReadLeadIds((current) => new Set(current).add(leadId));
  }

  useEffect(() => {
    let active = true;

    api
      .get(`/campaigns/${encodeURIComponent(campaignId)}`)
      .then((payload) => {
        if (!active) return;
        setCampaign(payload?.campaign ?? null);
        setError(null);
        setStatus('ready');
      })
      .catch((err) => {
        if (!active) return;
        if (err?.status === NOT_FOUND) {
          setStatus('missing');
          return;
        }
        setError(err.message);
        setStatus('error');
      });

    return () => {
      active = false;
    };
  }, [campaignId, reloadToken]);

  const generating = campaign?.status === 'generating';

  // A run under way re-reads itself until it is done. The polling stops when the
  // campaign leaves 'generating', because that condition IS the dependency.
  useEffect(() => {
    if (!generating) return undefined;

    const timer = setInterval(() => setReloadToken((token) => token + 1), POLL_MS);

    return () => clearInterval(timer);
  }, [generating]);

  if (status === 'loading') {
    return (
      <div>
        <BackToRoll />
        <p className="muted thread-note">Fetching the campaign…</p>
      </div>
    );
  }

  if (status === 'missing') {
    return (
      <div>
        <BackToRoll />
        <div className="kicker thread-kicker">Not found</div>
        <p className="muted thread-note">That campaign isn&apos;t in your roll.</p>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div>
        <BackToRoll />
        <p className="msg error" role="alert">
          {error}
        </p>
      </div>
    );
  }

  const leads = Array.isArray(campaign?.leads) ? campaign.leads : [];
  const mode = modeLabel(campaign?.mode);

  return (
    <div>
      <BackToRoll />

      <PageHead
        kicker={mode === '' ? 'Section IV' : `Section IV · ${mode} campaign`}
        title={<>{campaign?.name ?? '(untitled campaign)'}</>}
        sub={`${leads.length} ${leads.length === 1 ? 'recipient' : 'recipients'} on this campaign.`}
        aside={
          <div className="block--red pop replies-tally">
            <div className="kicker">Replies</div>
            <div className="serif tally">
              {tally(campaign?.repliedCount)}
              <span className="of">/{tally(campaign?.sentCount)}</span>
            </div>
          </div>
        }
      />

      <div className="register">
        <div className="reg-head">
          <span className="reg-no">No.</span>
          <span className="reg-subject">Recipient</span>
          <span className="reg-sent">Company</span>
          <span className="reg-status">Status</span>
        </div>

        {leads.map((lead, position) => (
          <LeadRow
            key={lead?.id ?? position}
            lead={lead}
            position={position}
            read={readLeadIds.has(lead?.id)}
            onOpen={openLead}
          />
        ))}

        {leads.length === 0 ? (
          <p className="muted reg-empty">
            No recipients yet. This campaign is waiting for its list.
          </p>
        ) : null}
      </div>

      {openLeadId ? (
        <LeadReview
          key={openLeadId}
          leadId={openLeadId}
          onClose={() => setOpenLeadId(null)}
          onChanged={reload}
        />
      ) : null}

      <CampaignGenerate campaign={campaign} onStarted={reload} />

      <CampaignLeadsPage campaignId={campaignId} onAdded={reload} />
    </div>
  );
}
