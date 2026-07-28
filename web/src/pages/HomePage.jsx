import { useEffect, useState } from 'react';

import { api } from '../lib/api.js';
import { getSupabase } from '../lib/supabase.js';

/**
 * Placeholder authenticated landing view (Phase 1).
 * Calls the authenticated smoke route GET /api/me to prove the JWT round-trip works.
 */
export default function HomePage({ session }) {
  const [apiUser, setApiUser] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;

    api
      .get('/me')
      .then((payload) => {
        if (active) setApiUser(payload?.user ?? null);
      })
      .catch((err) => {
        if (active) setError(err.message);
      });

    return () => {
      active = false;
    };
  }, []);

  async function signOut() {
    await getSupabase().auth.signOut();
  }

  return (
    <main className="shell">
      <div className="card">
        <h1>VoiceReach</h1>
        <p className="muted">Signed in as {session?.user?.email}</p>

        <h2>Server check</h2>
        {error ? <p className="error">API error: {error}</p> : null}
        {!error && !apiUser ? <p className="muted">Calling GET /api/me…</p> : null}
        {apiUser ? (
          <p className="notice">
            Server verified your token. User id: <code>{apiUser.id}</code>
          </p>
        ) : null}

        <p className="muted">
          Phase 1 scaffold. Gmail connect, voice profile, campaigns and the review screen land in
          later phases.
        </p>

        <button type="button" onClick={signOut}>
          Sign out
        </button>
      </div>
    </main>
  );
}
