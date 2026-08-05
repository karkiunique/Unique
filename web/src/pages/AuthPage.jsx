import { useState } from 'react';

import { getSupabase } from '../lib/supabase.js';

const MIN_PASSWORD_LENGTH = 8;

export default function AuthPage() {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const isSignup = mode === 'signup';

  function validate() {
    if (!email.trim() || !email.includes('@')) return 'Enter a valid email address.';
    if (password.length < MIN_PASSWORD_LENGTH) {
      return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    return null;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setBusy(true);
    try {
      const supabase = getSupabase();
      const credentials = { email: email.trim(), password };

      const { data, error: authError } = isSignup
        ? await supabase.auth.signUp(credentials)
        : await supabase.auth.signInWithPassword(credentials);

      if (authError) {
        setError(authError.message);
        return;
      }

      if (isSignup && !data?.session) {
        setNotice('Check your inbox to confirm your email, then sign in.');
        setMode('login');
        setPassword('');
      }
      // On success with a session, App's onAuthStateChange swaps in the home view.
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function switchMode() {
    setMode(isSignup ? 'login' : 'signup');
    setError(null);
    setNotice(null);
  }

  return (
    <main className="shell">
      <form className="card" onSubmit={handleSubmit}>
        <h1>Unique</h1>
        <p className="muted">{isSignup ? 'Create your account' : 'Sign in to continue'}</p>

        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          required
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete={isSignup ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          required
        />

        {error ? <p className="error">{error}</p> : null}
        {notice ? <p className="notice">{notice}</p> : null}

        <button type="submit" disabled={busy}>
          {busy ? 'Working…' : isSignup ? 'Sign up' : 'Sign in'}
        </button>

        <button type="button" className="link" onClick={switchMode} disabled={busy}>
          {isSignup ? 'Already have an account? Sign in' : 'No account? Sign up'}
        </button>
      </form>
    </main>
  );
}
