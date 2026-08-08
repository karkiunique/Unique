import { useEffect, useState } from 'react';

import Icon from './Icon.jsx';
import { PageHead } from './Shell.jsx';
import CampaignLeadsPage from '../pages/CampaignLeadsPage.jsx';
import { api } from '../lib/api.js';
import { navigateTo } from '../lib/navigate.js';

/**
 * One campaign, read only.
 *
 * The recipients are listed by name and address with their status — the letters
 * themselves are not fetched here. Editing a generated letter is the review
 * screen's job, and until that exists there is nothing on this page that has any
 * business carrying an email body.
 *
 * A campaign that is not the caller's comes back 404 from the server, and reads
 * here as "not in your roll" rather than as a fault.
 */

const NOT_FOUND = 404;
const MODE_LABELS = { voice: 'Voice', template: 'Template' };

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
          <div className="reg-row" key={lead?.id ?? position}>
            <span className="reg-no">{String(position + 1).padStart(2, '0')}</span>
            <span className="reg-subject">
              <span className="t">{fullName(lead) || lead?.email || 'Unknown'}</span>
              <span className="a">{lead?.email ?? ''}</span>
            </span>
            <span className="reg-sent">{lead?.company ?? ''}</span>
            <span className="reg-status">
              <span className="camp-status">{lead?.status ?? 'pending'}</span>
            </span>
          </div>
        ))}

        {leads.length === 0 ? (
          <p className="muted reg-empty">
            No recipients yet. This campaign is waiting for its list.
          </p>
        ) : null}
      </div>

      <CampaignLeadsPage
        campaignId={campaignId}
        onAdded={() => setReloadToken((token) => token + 1)}
      />
    </div>
  );
}
