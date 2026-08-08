/**
 * One line of the campaign roll.
 *
 * A button, like the register's rows: the whole line opens the campaign, so the
 * hit target is the line the eye is already on. Everything shown comes from the
 * API — the counts are the server's, and this component derives none of its own.
 */

const MODE_LABELS = { voice: 'Voice', template: 'Template' };

// The statuses where something is actually moving, and the row should say so.
const LIVE_STATUSES = ['generating', 'sending'];

function tally(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** '' for anything that is not one of the two modes — never a raw lookup result. */
function modeLabel(mode) {
  const label = MODE_LABELS[mode];

  return typeof label === 'string' ? label : '';
}

function nameOf(campaign) {
  const name = campaign?.name;

  return typeof name === 'string' && name.trim() !== '' ? name : '(untitled campaign)';
}

function startedOn(value) {
  if (typeof value !== 'string' || value === '') return '';

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return '';

  return new Date(parsed).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

export default function CampaignRow({ campaign, position, onOpen }) {
  const campaignId = typeof campaign?.id === 'string' ? campaign.id : '';
  const mode = modeLabel(campaign?.mode);
  const status = typeof campaign?.status === 'string' ? campaign.status : 'draft';
  const started = startedOn(campaign?.created_at);

  function open() {
    if (campaignId === '' || typeof onOpen !== 'function') return;
    onOpen(campaignId);
  }

  return (
    <button type="button" className="reg-row" onClick={open}>
      <span className="reg-no">{String(position + 1).padStart(2, '0')}</span>

      <span className="reg-subject">
        <span className="t">{nameOf(campaign)}</span>
        <span className="a">
          {mode === '' ? null : <span className="camp-mode">{mode}</span>}
          {started}
        </span>
      </span>

      <span className="reg-sent">
        <span className="camp-tally">{tally(campaign?.sentCount)} sent</span>
        <span className="time">{tally(campaign?.repliedCount)} replied</span>
      </span>

      <span className="reg-status">
        <span className={LIVE_STATUSES.includes(status) ? 'camp-status live' : 'camp-status'}>
          {status}
        </span>
      </span>
    </button>
  );
}
