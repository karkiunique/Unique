import { useEffect, useState } from 'react';

import AuthPage from './pages/AuthPage.jsx';
import CampaignBuilderPage from './pages/CampaignBuilderPage.jsx';
import CampaignsPage from './pages/CampaignsPage.jsx';
import ComposePage from './pages/ComposePage.jsx';
import OnboardingPage from './pages/OnboardingPage.jsx';
import ThreadsPage from './pages/ThreadsPage.jsx';
import UnsubscribePage, { unsubscribeTokenFromPath } from './pages/UnsubscribePage.jsx';
import { Shell } from './components/Shell.jsx';
import SignoffNamePrompt from './components/SignoffNamePrompt.jsx';
import { isSupabaseConfigured, getSupabase } from './lib/supabase.js';

/**
 * Path-based navigation, no router (CLAUDE.md). Full-page navigation goes
 * through lib/navigate.js so tests can assert on it without navigating, and an
 * unrecognised path falls back to onboarding rather than a blank screen.
 */
const PAGES = {
  '/compose': ComposePage,
  '/threads': ThreadsPage,
  '/campaigns': CampaignsPage,
  '/campaigns/new': CampaignBuilderPage
};

// One opened campaign. Matched here rather than in the page so the pages stay
// free of window.location, exactly as the rest of the app is.
const OPEN_CAMPAIGN = /^\/campaigns\/([^/]+)$/;

function currentPath() {
  try {
    return window.location.pathname || '/';
  } catch {
    return '/';
  }
}

/** Which page renders, which tab reads as current, and which campaign is open. */
function resolveRoute(path) {
  if (PAGES[path]) {
    return {
      Page: PAGES[path],
      // The builder is not its own section: Campaigns stays the current tab.
      shellPath: path === '/campaigns/new' ? '/campaigns' : path,
      campaignId: null
    };
  }

  const opened = path.match(OPEN_CAMPAIGN);
  if (opened) return { Page: CampaignsPage, shellPath: '/campaigns', campaignId: opened[1] };

  return { Page: OnboardingPage, shellPath: '/', campaignId: null };
}

export default function App() {
  const path = currentPath();
  // `/u/<token>` is the one route a stranger reaches: it is public by design.
  const isUnsubscribeRoute = Boolean(unsubscribeTokenFromPath(path));

  const configured = isSupabaseConfigured();
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(configured);

  useEffect(() => {
    // A recipient unsubscribing is not a user — never touch auth on their behalf.
    if (!configured || isUnsubscribeRoute) return undefined;

    const supabase = getSupabase();
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data?.session ?? null);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession ?? null);
    });

    return () => {
      active = false;
      listener?.subscription?.unsubscribe();
    };
  }, [configured, isUnsubscribeRoute]);

  // Before the auth gate: this page must render with no session and no app chrome.
  if (isUnsubscribeRoute) return <UnsubscribePage />;

  if (!configured) {
    return (
      <main className="shell">
        <div className="card">
          <h1>Unique</h1>
          <p className="error">Supabase is not configured.</p>
          <p className="muted">
            Copy <code>web/.env.example</code> to <code>web/.env</code> and set
            <code> VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>, then restart
            the dev server.
          </p>
        </div>
      </main>
    );
  }

  if (loading) {
    return (
      <main className="shell">
        <div className="card">
          <p className="muted">Loading…</p>
        </div>
      </main>
    );
  }

  if (!session) return <AuthPage />;

  const { Page, shellPath, campaignId } = resolveRoute(path);

  return (
    <Shell email={session?.user?.email} path={shellPath}>
      {/* Pre-006 accounts have no sign-off name. Asks for it once, blocks nothing. */}
      <SignoffNamePrompt />
      <Page session={session} campaignId={campaignId} />
    </Shell>
  );
}
