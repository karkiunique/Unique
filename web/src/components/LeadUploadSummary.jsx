import Icon from './Icon.jsx';

/**
 * What the server did with the list: added, skipped, rejected — and, separately,
 * which addresses look like they will bounce.
 *
 * The server returns stable machine codes; the prose lives here, the same
 * division RecipientFlag already uses.
 */

const LISTED_ROWS = 10;

const OUTCOME_NOTE = {
  duplicate_in_file: 'listed more than once in this file',
  duplicate_in_campaign: 'already on this campaign',
  missing_email: 'no email address',
  invalid_email: 'not a valid email address',
  email_too_long: 'email address is too long',
  not_a_row: 'not a readable row'
};

const FLAG_NOTE = {
  no_mx: 'this domain has no mail server, so it will bounce',
  dns_timeout: 'the domain lookup timed out, so this one is unchecked',
  dns_error: 'the domain lookup could not be completed, so this one is unchecked',
  role_address: 'a shared role inbox — rarely answered, quick to report cold mail',
  disposable_domain: 'a disposable, throwaway domain'
};

function noteFor(map, code) {
  return map[code] ?? code;
}

function reasonNotes(reasons) {
  const codes = Array.isArray(reasons) ? reasons : [];

  return codes.map((reason) => noteFor(FLAG_NOTE, reason)).join('; ');
}

/** Row-level outcomes are only useful in aggregate — 400 identical lines are not. */
function tallyByReason(entries) {
  const counts = new Map();

  for (const entry of entries) {
    const reason = typeof entry?.reason === 'string' ? entry.reason : 'unknown';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }

  return [...counts.entries()];
}

function OutcomeList({ heading, entries }) {
  if (entries.length === 0) return null;

  return (
    <div className="lead-outcome">
      <div className="kicker">{heading}</div>
      <ul className="lead-reasons">
        {tallyByReason(entries).map(([reason, count]) => (
          <li key={reason}>{`${count} — ${noteFor(OUTCOME_NOTE, reason)}`}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The row in the uploaded FILE, one-based — the number the user can scroll to.
 * A long list is sent in batches and each batch reports its own row 0, so the
 * page re-bases these before they get here; showing the number is what makes
 * that re-basing worth doing. Omitted when the server gave no index.
 */
function RowNumber({ index }) {
  if (!Number.isInteger(index)) return null;

  return <span className="lead-row">{`Row ${index + 1}`}</span>;
}

/**
 * Bounce risk, stated and then got out of the way. Every flagged address was
 * added: MX proves a domain can receive mail, never that a mailbox exists, and a
 * lookup that did not finish is not a verdict on anybody's address.
 */
function BounceFlags({ flagged }) {
  if (flagged.length === 0) return null;

  return (
    <div className="lead-flags" role="status">
      <div className="kicker">
        <Icon name="triangle-alert" />
        Bounce risk
      </div>
      <p className="lead-advisory">
        Advisory only — every one of these was added. These letters leave your own Gmail, so bounces
        land on your personal sender reputation.
      </p>
      <ul className="lead-reasons">
        {flagged.slice(0, LISTED_ROWS).map((flag) => (
          <li key={`${flag.index}-${flag.email}`}>
            <RowNumber index={flag.index} />
            {`${flag.email} — ${reasonNotes(flag.reasons)}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function LeadUploadSummary({ result }) {
  return (
    <div className="lead-result">
      <p className="mono lead-tally">
        <span data-tally="inserted">{`${result.inserted} added`}</span>
        <span data-tally="skipped">{`${result.skipped.length} skipped`}</span>
        <span data-tally="rejected">{`${result.rejected.length} rejected`}</span>
      </p>

      <OutcomeList heading="Skipped as duplicates" entries={result.skipped} />
      <OutcomeList heading="Rejected" entries={result.rejected} />
      <BounceFlags flagged={result.flagged} />
    </div>
  );
}
