import { useState } from 'react';

import Icon from './Icon.jsx';
import { joinWaitlist } from '../lib/waitlist.js';

/**
 * The inverted waitlist block, and the stamped confirmation it becomes.
 *
 * The seat number comes from the SERVER, never from the local counter: it is the
 * one number this page states as a fact about a specific person, so it has to be
 * the number actually issued to them.
 */
export default function WaitlistJoin({ count, onJoined }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [joined, setJoined] = useState(null);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);

    const address = email.trim();
    if (address === '' || !address.includes('@')) {
      setError('Enter a valid email address.');
      return;
    }

    setBusy(true);
    try {
      const result = await joinWaitlist(address);
      setJoined({ seat: result.seat, email: address });
      onJoined?.(result.count);
    } catch (err) {
      // A `status` means the server answered and the message is OURS — written
      // server-side, safe to show, and never containing the address.
      //
      // No status means the request never landed, and fetch rejects with a
      // TypeError reading "Failed to fetch". That is a developer string; showing
      // it to someone trying to join a waitlist tells them nothing they can act on
      // and looks broken. The server being down is our problem, not theirs.
      setError(
        err?.status ? err.message : 'Could not reach the waitlist. Please try again in a moment.'
      );
    } finally {
      setBusy(false);
    }
  }

  if (joined) {
    return (
      <div className="joined">
        <span className="stamp">
          <Icon name="check" /> You’re on the list
        </span>
        <p>
          You’re <b>No. {joined.seat}</b> on the waitlist. We’ll write to <b>{joined.email}</b> the
          moment a seat opens.
        </p>
      </div>
    );
  }

  return (
    <div>
      <form onSubmit={handleSubmit} noValidate>
        <label className="visually-hidden" htmlFor="waitlist-email">
          Email address
        </label>
        <input
          id="waitlist-email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
          required
        />
        <button className="btn-lite" type="submit" disabled={busy}>
          {busy ? 'Reserving…' : 'Reserve my seat'}
          <Icon name={busy ? 'loader' : 'stamp'} />
        </button>
      </form>

      {error ? (
        <p className="join-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="fine">No credit card · One email when it’s your turn · Unsubscribe anytime</div>

      <div className="jcount">
        <span className="dotpulse" aria-hidden="true" />
        <b>{count}</b> already reserved a seat
      </div>
    </div>
  );
}
