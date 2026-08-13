import { useEffect, useState } from 'react';

import Icon from './Icon.jsx';
import { api } from '../lib/api.js';

/**
 * The backfill prompt for the sign-off name (CLAUDE.md, Decisions 2026-08-13).
 *
 * Accounts created before migration 006 have no `full_name`, and a name cannot be
 * invented for them. They are asked for it on next login — here, as a banner
 * above whatever page they opened.
 *
 * IT BLOCKS NOTHING. Not the page, not a draft, not a send. A user who ignores it
 * keeps exactly today's behaviour (the sign-off check falls back to matching
 * their own closings, which an established account has). So every failure path in
 * this component renders nothing at all rather than an error the user cannot act
 * on: the name is worth asking for, never worth standing in front of the app for.
 */

const MAX_NAME_LENGTH = 80;

export default function SignoffNamePrompt() {
  const [needed, setNeeded] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;

    api
      .get('/me')
      .then((payload) => {
        if (!active) return;
        const stored = payload?.user?.full_name;
        setNeeded(typeof stored !== 'string' || stored.trim() === '');
      })
      // Not knowing whether they need the prompt is a reason to stay quiet, not
      // to interrupt someone who may well have a name already.
      .catch(() => {});

    return () => {
      active = false;
    };
  }, []);

  async function save(event) {
    event.preventDefault();
    setError(null);

    const fullName = name.trim();
    if (fullName === '') {
      setError('Enter the name you sign emails with.');
      return;
    }

    setBusy(true);
    try {
      await api.patch('/me', { full_name: fullName });
      setNeeded(false);
    } catch (err) {
      setError(err?.message || 'Could not save your name.');
    } finally {
      setBusy(false);
    }
  }

  if (!needed) return null;

  return (
    <div className="card namebanner">
      <div className="kicker red">One thing missing</div>
      <p>
        Every email we draft signs off with your name. Tell us how you sign yours, and we will
        never send an unsigned letter under it.
      </p>

      <form onSubmit={save} className="rowline namebanner-form">
        <div className="rfield">
          <label htmlFor="signoff-name">Your full name</label>
          <input
            id="signoff-name"
            className="rinput"
            type="text"
            autoComplete="name"
            maxLength={MAX_NAME_LENGTH}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="the name you sign emails with"
          />
        </div>
        <button className="btn red" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save my name'}
          <Icon name={busy ? 'loader' : 'arrow-right'} />
        </button>
      </form>

      {error ? (
        <p className="msg error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
