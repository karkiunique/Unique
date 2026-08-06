import Icon from './Icon.jsx';

/**
 * The deliverability flag that sits under the To field.
 *
 * Advisory, never a gate. It flags loudly and then gets out of the way: the
 * server's check is a risk signal (MX proves a domain accepts mail, never that
 * a mailbox exists), and the user may know something we do not.
 *
 * The stakes are personal, so the copy says so — the letter leaves the user's
 * OWN Gmail, and a bounce lands on their real sender reputation.
 *
 * The server returns stable machine codes; the prose lives here.
 */

const REASON_NOTE = {
  syntax: 'This is not a valid email address.',
  no_mx: 'This domain has no mail server. It cannot receive mail at all, so this will bounce.',
  role_address:
    'This is a shared role inbox — info@, support@, sales@ and the like. They are worked through by a rota, rarely answered, and quick to mark cold mail as spam.',
  disposable_domain:
    'This is a disposable, throwaway domain. Mail sent to it is discarded, and often bounces.',
  dns_timeout: 'The domain lookup timed out.',
  dns_error: 'The domain lookup could not be completed.'
};

const BOUNCE_COST =
  'This letter leaves your own Gmail. Bounces damage your personal sender reputation and can get your real mailbox rate-limited.';
const QUALITY_COST =
  'Spam reports and dead mail hit the same reputation you send everything else from. The cost is yours, not the recipient’s.';

function noteFor(reason) {
  return REASON_NOTE[reason] ?? null;
}

function headlineFor(status, reasons) {
  if (status === 'warn') return 'Risky address';

  return reasons.includes('syntax') ? 'Not a valid address' : 'This will bounce';
}

export default function RecipientFlag({ checking, verification }) {
  if (checking) {
    return (
      <p className="mono verify-line" data-verify="checking">
        Checking the domain…
      </p>
    );
  }

  if (!verification) return null;

  const status = verification.status;
  const reasons = Array.isArray(verification.reasons) ? verification.reasons : [];

  if (status === 'ok') {
    return (
      <p className="mono verify-line ok" data-verify="ok">
        <Icon name="check" />
        Domain accepts mail
      </p>
    );
  }

  // Anything we do not recognise is presented as "we do not know", never as a
  // problem with the address. A failed check must not read as a bad address.
  if (status !== 'invalid' && status !== 'warn') {
    return (
      <div className="verify-flag unknown" data-verify="unknown" role="status">
        <div className="kicker verify-head">Check did not complete</div>
        <p className="verify-note">
          We could not finish checking this domain. That is not a verdict on the address — it may be
          perfectly good.
        </p>
        <p className="verify-advisory">Nothing is blocked. Send it if you know it is right.</p>
      </div>
    );
  }

  const invalid = status === 'invalid';
  const notes = reasons.map(noteFor).filter(Boolean);

  return (
    <div
      className={invalid ? 'verify-flag invalid' : 'verify-flag warn'}
      data-verify={status}
      role="alert"
    >
      <div className="kicker verify-head">
        <Icon name="triangle-alert" />
        {headlineFor(status, reasons)}
      </div>

      {notes.map((note) => (
        <p key={note} className="verify-note">
          {note}
        </p>
      ))}

      <p className="verify-cost">{invalid ? BOUNCE_COST : QUALITY_COST}</p>
      <p className="verify-advisory">Advisory only — you can still send it.</p>
    </div>
  );
}
