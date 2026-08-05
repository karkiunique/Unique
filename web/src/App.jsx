import { useEffect, useState } from 'react';

import AuthPage from './pages/AuthPage.jsx';
import ComposePage from './pages/ComposePage.jsx';
import OnboardingPage from './pages/OnboardingPage.jsx';
import ThreadsPage from './pages/ThreadsPage.jsx';
import { navigateTo } from './lib/navigate.js';
import { getSupabase, isSupabaseConfigured } from './lib/supabase.js';

/**
 * Path-based navigation, no router (CLAUDE.md). Full-page navigation goes
 * through lib/navigate.js so tests can assert on it without navigating, and an
 * unrecognised path falls back to onboarding rather than a blank screen.
 */
const PAGES = {
  '/compose': ComposePage,
  '/threads': ThreadsPage
};

const NAV_LINKS = [
  ['/', 'Voice profile'],
  ['/compose', 'Compose'],
  ['/threads', 'Sent & replies']
];

function currentPath() {
  try {
    return window.location.pathname || '/';
  } catch {
    return '/';
  }
}

export default function App() {
  const configured = isSupabaseConfigured();
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(configured);

  useEffect(() => {
    if (!configured) return undefined;

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
  }, [configured]);

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

  const Page = PAGES[currentPath()] ?? OnboardingPage;

  return (
    <>
      <nav className="topnav">
        {NAV_LINKS.map(([path, label]) => (
          <button key={path} type="button" className="link" onClick={() => navigateTo(path)}>
            {label}
          </button>
        ))}
      </nav>
      <Page session={session} />
    </>
  );
}
