import { useEffect, useState } from 'react';

import AuthPage from './pages/AuthPage.jsx';
import HomePage from './pages/HomePage.jsx';
import { getSupabase, isSupabaseConfigured } from './lib/supabase.js';

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
          <h1>VoiceReach</h1>
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

  return session ? <HomePage session={session} /> : <AuthPage />;
}
