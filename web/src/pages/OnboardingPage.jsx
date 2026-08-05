import { useEffect, useRef, useState } from 'react';

import CorpusViewer from '../components/CorpusViewer.jsx';
import VoiceProfileSummary from '../components/VoiceProfileSummary.jsx';
import { api } from '../lib/api.js';
import { getQueryParam, navigateTo } from '../lib/navigate.js';
import { getSupabase } from '../lib/supabase.js';

/**
 * Onboarding — the authenticated landing view (CLAUDE.md, Frontend pages 1).
 *
 * A state machine derived from data, not a router: checking -> disconnected ->
 * connected -> building -> ready, with errors rendered inline at every step.
 *
 * Deliberately does NOT auto-generate the profile when Gmail comes back
 * connected: the user has to be able to inspect the ingestion corpus before a
 * profile is built from it, so the build is always an explicit click.
 */

const BUILD_NOTE =
  'This reads up to your 100 most recent sent emails and can take a minute.';

export default function OnboardingPage({ session }) {
  const [checking, setChecking] = useState(true);
  const [profile, setProfile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Read once: the OAuth return marker must not flip mid-session.
  const [returnedFromOAuth] = useState(() => getQueryParam('connected') === '1');

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setChecking(true);
    setError(null);

    api
      .get('/voice')
      .then((payload) => {
        if (active) setProfile(payload?.profile ?? null);
      })
      .catch((err) => {
        if (!active) return;
        // 404 just means "no profile yet" — that is a normal onboarding state.
        if (err?.status === 404) setProfile(null);
        else setError(err.message);
      })
      .finally(() => {
        if (active) setChecking(false);
      });

    return () => {
      active = false;
    };
  }, [reloadKey]);

  async function connectGmail() {
    setError(null);
    setBusy(true);
    try {
      const payload = await api.post('/gmail/connect');
      const url = payload?.url;
      if (!url) throw new Error('The server did not return a Google consent URL');
      navigateTo(url);
    } catch (err) {
      if (!mounted.current) return;
      setError(err.message);
      setBusy(false);
    }
  }

  async function buildProfile() {
    setError(null);
    setBusy(true);
    try {
      const payload = await api.post('/voice/generate');
      if (mounted.current) setProfile(payload?.profile ?? null);
    } catch (err) {
      if (mounted.current) setError(err.message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  function retry() {
    setError(null);
    setReloadKey((key) => key + 1);
  }

  async function signOut() {
    await getSupabase().auth.signOut();
  }

  const ready = !checking && Boolean(profile);
  const connected = !checking && !profile && returnedFromOAuth;
  const disconnected = !checking && !profile && !returnedFromOAuth;

  return (
    <main className="shell top">
      <div className="card wide">
        <h1>Unique</h1>
        <p className="muted">Signed in as {session?.user?.email}</p>

        {checking ? <p className="muted">Checking your voice profile…</p> : null}

        {disconnected ? (
          <>
            <h2>Connect Gmail</h2>
            <p className="muted">
              Unique reads your sent mail read-only, to learn how you actually write. Nothing is
              sent from your account until you confirm it, one email at a time.
            </p>
            <button type="button" onClick={connectGmail} disabled={busy}>
              Connect Gmail
            </button>
          </>
        ) : null}

        {connected ? (
          <>
            <h2>Gmail connected</h2>
            <p className="muted">
              Check the ingested sent mail below before building a profile from it. Junk in the
              corpus means the profile learns the wrong voice.
            </p>
            <CorpusViewer />
            {busy ? (
              <p className="notice">Building your voice profile… {BUILD_NOTE}</p>
            ) : (
              <p className="muted">{BUILD_NOTE}</p>
            )}
            <button type="button" onClick={buildProfile} disabled={busy}>
              Build my voice profile
            </button>
          </>
        ) : null}

        {ready ? (
          <>
            <h2>Your voice profile</h2>
            <VoiceProfileSummary profile={profile} />
            {busy ? <p className="notice">Rebuilding your voice profile… {BUILD_NOTE}</p> : null}
            <button type="button" onClick={buildProfile} disabled={busy}>
              Regenerate
            </button>
          </>
        ) : null}

        {error ? (
          <>
            <p className="error">{error}</p>
            <button type="button" className="link" onClick={retry} disabled={busy}>
              Try again
            </button>
          </>
        ) : null}

        <button type="button" className="link" onClick={signOut}>
          Sign out
        </button>
      </div>
    </main>
  );
}
