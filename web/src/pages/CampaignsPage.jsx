import { useEffect, useState } from 'react';

import CampaignDetail from '../components/CampaignDetail.jsx';
import CampaignRow from '../components/CampaignRow.jsx';
import Icon from '../components/Icon.jsx';
import { PageHead } from '../components/Shell.jsx';
import { api } from '../lib/api.js';
import { navigateTo } from '../lib/navigate.js';

/**
 * Section IV — the campaign roll: every run set up at this desk, with how many
 * letters have gone out and how many came back.
 *
 * The counts are the server's, computed from the leads it owns. Nothing here
 * reads a campaign that is not the caller's: the list endpoint filters on the
 * authenticated user, and an opened campaign 404s unless it is theirs.
 */

function tally(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function sumOf(campaigns, field) {
  return campaigns.reduce((total, campaign) => total + tally(campaign?.[field]), 0);
}

function CampaignRoll() {
  const [campaigns, setCampaigns] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;

    api
      .get('/campaigns')
      .then((payload) => {
        if (!active) return;
        setCampaigns(Array.isArray(payload?.campaigns) ? payload.campaigns : []);
        setError(null);
        setLoaded(true);
      })
      .catch((err) => {
        if (!active) return;
        setError(err.message);
        setLoaded(true);
      });

    return () => {
      active = false;
    };
  }, []);

  const sent = sumOf(campaigns, 'sentCount');
  const replied = sumOf(campaigns, 'repliedCount');

  return (
    <>
      <PageHead
        kicker="Section IV"
        title={
          <>
            The <em>campaign</em> roll.
          </>
        }
        sub="Every run you have set up here — how it is written, how far it has got, and who wrote back."
        aside={
          <div className="block--red pop replies-tally">
            <div className="kicker">Replies</div>
            <div className="serif tally">
              {replied}
              <span className="of">/{sent}</span>
            </div>
          </div>
        }
      />

      <div className="reg-toolbar">
        <p className="muted camp-count">
          {campaigns.length} {campaigns.length === 1 ? 'campaign' : 'campaigns'}
        </p>

        <button type="button" className="btn red" onClick={() => navigateTo('/campaigns/new')}>
          <Icon name="plus" />
          New campaign
        </button>
      </div>

      {error ? (
        <p className="msg error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="register">
        <div className="reg-head">
          <span className="reg-no">No.</span>
          <span className="reg-subject">Campaign</span>
          <span className="reg-sent">Sent &amp; replies</span>
          <span className="reg-status">Status</span>
        </div>

        {campaigns.map((campaign, position) => (
          <CampaignRow
            key={campaign?.id ?? position}
            campaign={campaign}
            position={position}
            onOpen={(campaignId) => navigateTo(`/campaigns/${campaignId}`)}
          />
        ))}

        {/* Not an error state: nothing has gone wrong, there is simply no run yet. */}
        {loaded && !error && campaigns.length === 0 ? (
          <p className="muted reg-empty">
            No campaigns yet. Start one and it will keep its own count here.
          </p>
        ) : null}
      </div>

      <p className="tick reg-note">
        <Icon name="lock" />
        Only your campaigns are listed — every read is scoped to your account on the server.
      </p>
    </>
  );
}

export default function CampaignsPage({ campaignId = null }) {
  // Two views, one section. The switch sits above both so neither component has
  // to run its hooks for a view it is not rendering.
  return campaignId ? <CampaignDetail campaignId={campaignId} /> : <CampaignRoll />;
}
