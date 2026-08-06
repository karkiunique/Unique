import { useState } from 'react';

import Icon from './Icon.jsx';
import { api } from '../lib/api.js';
import { navigateTo } from '../lib/navigate.js';

/**
 * An API error, plus the recovery action when the server names one.
 *
 * The action is read from the server's machine-readable `action` code, never
 * from the wording of the message: prose gets rewritten, and a UI that
 * pattern-matches English quietly loses the recovery path when it does.
 *
 * `reconnect_gmail` means the grant needs re-consent — a revoked token, or one
 * that predates a scope we now need. Describing that to the user is not enough:
 * without a button here there is no way out of the compose flow at all.
 */

export const RECONNECT_ACTION = 'reconnect_gmail';

export default function ErrorNotice({ message, action }) {
  const [busy, setBusy] = useState(false);
  const [connectError, setConnectError] = useState(null);

  /** Exactly the Connect Gmail path from onboarding — one OAuth start, in one place. */
  async function reconnect() {
    setConnectError(null);
    setBusy(true);
    try {
      const payload = await api.post('/gmail/connect');
      const url = payload?.url;
      if (!url) throw new Error('The server did not return a Google consent URL');
      navigateTo(url);
    } catch (err) {
      setConnectError(err.message);
      setBusy(false);
    }
  }

  if (!message) return null;

  return (
    <>
      <p className="msg error" role="alert">
        {message}
      </p>

      {action === RECONNECT_ACTION ? (
        <div className="reconnect">
          <button
            type="button"
            className="btn red reconnect-cta"
            onClick={reconnect}
            disabled={busy}
          >
            <Icon name={busy ? 'loader' : 'mail'} />
            {busy ? 'Opening Google…' : 'Reconnect Gmail'}
          </button>
          <p className="reconnect-note">
            Google will ask you to approve the permission. You leave this page to do it, so copy
            your letter first if you want to keep it.
          </p>
          {connectError ? (
            <p className="msg error" role="alert">
              {connectError}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
