import { useEffect, useRef, useState } from 'react';

import CorpusStats from '../components/CorpusStats.jsx';
import CorpusViewer from '../components/CorpusViewer.jsx';
import Icon from '../components/Icon.jsx';
import { PageHead } from '../components/Shell.jsx';
import VoiceProfileSummary from '../components/VoiceProfileSummary.jsx';
import { api } from '../lib/api.js';
import { getQueryParam, navigateTo } from '../lib/navigate.js';
import { getSupabase } from '../lib/supabase.js';

/**
 * Section I — the voice profile (CLAUDE.md, Frontend pages 1).
 *
 * A state machine derived from data, not a router: checking -> disconnected ->
 * connected -> ready, with errors rendered inline at every step.
 *
 * Deliberately does NOT auto-generate the profile when Gmail comes back
 * connected: the user has to be able to inspect what was ingested before a
 * profile is built from it, so the build is always an explicit click.
 */

const HEADS = {
  checking: {
    kicker: 'Section I',
    title: 'Your voice profile',
    sub: 'Looking up what we already have on file.'
  },
  disconnected: {
    kicker: 'Section I',
    title: 'Your voice profile',
    sub: 'Connect your inbox so we can learn your hand.'
  },
  connected: {
    kicker: 'Section I',
    title: 'Your voice profile',
    sub: 'Read the corpus, then let us take it down.'
  },
  ready: {
    kicker: 'On the record',
    title: (
      <>
        Your voice, <em>on the record</em>.
      </>
    ),
    sub: 'How you write — taken down verbatim from your sent mail.'
  }
};

function stageOf(checking, profile, returnedFromOAuth) {
  if (checking) return 'checking';
  if (profile) return 'ready';
  return returnedFromOAuth ? 'connected' : 'disconnected';
}

function ConnectState({ onConnect, busy }) {
  return (
    <div className="block connect">
      <div className="connect-stamp">
        <span className="stamp ink">Not yet connected</span>
      </div>

      <div className="kicker red">Awaiting your mailbox</div>
      <h2>
        We can&apos;t take down your voice
        <br />
        <em>until we can read your hand.</em>
      </h2>
      <p className="lead measure connect-lead">
        Unique reads your sent mail read-only. Nothing leaves your account until you confirm it, one
        email at a time.
      </p>

      <button type="button" className="btn red connect-cta" onClick={onConnect} disabled={busy}>
        <Icon name={busy ? 'loader' : 'mail'} />
        Connect Gmail
      </button>

      <div className="rowline connect-ticks">
        <span className="tick">
          <Icon name="lock" />
          Read-only
        </span>
        <span className="tick">
          <Icon name="eye-off" />
          Never stored
        </span>
        <span className="tick">
          <Icon name="pen-line" />
          You approve every send
        </span>
      </div>
    </div>
  );
}

function IngestState({ onBuild, busy }) {
  return (
    <div className="stack ingest">
      <CorpusStats />

      {/*
        Dev-only. It renders the cleaned bodies, so outside a dev environment the
        server 404s and this is invisible: production sees the counts above and
        no message text at all.
      */}
      <CorpusViewer />

      <div>
        <button type="button" className="btn red ingest-cta" onClick={onBuild} disabled={busy}>
          <Icon name={busy ? 'loader' : 'feather'} />
          {busy ? 'Taking down your voice…' : 'Build my voice profile'}
        </button>
        <p className="kicker ingest-note">
          Up to your 100 most recent sent emails · about a minute
        </p>
      </div>
    </div>
  );
}

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

  const stage = stageOf(checking, profile, returnedFromOAuth);
  const head = HEADS[stage];

  return (
    <>
      <PageHead
        kicker={head.kicker}
        title={head.title}
        sub={head.sub}
        aside={
          stage === 'ready' ? (
            <div className="stack dossier-aside">
              <span className="stamp green">Active</span>
              <button type="button" className="linkbtn" onClick={buildProfile} disabled={busy}>
                {busy ? 'Regenerating…' : '↻ Regenerate'}
              </button>
            </div>
          ) : null
        }
      />

      {stage === 'checking' ? (
        <p className="tick">
          <Icon name="loader" />
          Checking your voice profile…
        </p>
      ) : null}

      {stage === 'disconnected' ? <ConnectState onConnect={connectGmail} busy={busy} /> : null}
      {stage === 'connected' ? <IngestState onBuild={buildProfile} busy={busy} /> : null}
      {stage === 'ready' ? <VoiceProfileSummary profile={profile} /> : null}

      {error ? (
        <>
          <p className="msg error" role="alert">
            {error}
          </p>
          <button type="button" className="linkbtn" onClick={retry} disabled={busy}>
            Try again
          </button>
        </>
      ) : null}

      <div className="rowline page-foot">
        <span className="kicker">Signed in as {session?.user?.email}</span>
        <button type="button" className="linkbtn" onClick={signOut}>
          Sign out
        </button>
      </div>
    </>
  );
}
