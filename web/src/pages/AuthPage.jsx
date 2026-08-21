import { useState } from 'react';

import Icon from '../components/Icon.jsx';
import { getSupabase } from '../lib/supabase.js';

const MIN_PASSWORD_LENGTH = 8;
// Matches MAX_SENDER_NAME_LENGTH on the server, which is the real gate.
const MAX_NAME_LENGTH = 80;

const STEPS = [
  ['01', 'Connect Gmail, read-only'],
  ['02', 'We take down how you write'],
  ['03', 'You approve every word that ships']
];

export default function AuthPage() {
  const [mode, setMode] = useState('login');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const isSignup = mode === 'signup';

  function validate() {
    // The sign-off name (CLAUDE.md, Decisions 2026-08-13): every email we draft
    // has to end with the sender's own name, so it is required at signup — and it
    // is the ONLY thing signup asks for beyond credentials.
    if (isSignup && fullName.trim() === '') return 'Enter your full name.';
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

      // The name travels as auth metadata: the migration 006 trigger reads
      // raw_user_meta_data->>'full_name' and writes it onto the profile row, so
      // there is no second write to get wrong or to lose.
      const { data, error: authError } = isSignup
        ? await supabase.auth.signUp({
            ...credentials,
            options: { data: { full_name: fullName.trim() } }
          })
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
    <main className="auth">
      <section className="auth-left">
        <div className="auth-brand">
          <div className="wordmark">
            Unique<span className="dot">.</span>
          </div>
          <div className="kicker">Est. at your desk</div>
        </div>

        <div className="auth-hero">
          <div className="kicker red">No. 001 · The voice issue</div>
          <h1>
            Cold emails that sound like <em>you</em> wrote them.
          </h1>
          <p className="lead auth-lead">
            Because you did. Unique learns your voice from your sent mail, then drafts outreach in
            your hand, sent from your own inbox, never without your say-so.
          </p>
          <div className="auth-steps">
            {STEPS.map(([numeral, text]) => (
              <div className="auth-step" key={numeral}>
                <span className="n">{numeral}</span>
                <span className="t">{text}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="kicker">Read-only · Never stored · Human-confirmed</div>
      </section>

      <section className="auth-right">
        <div className="auth-slip">
          <div className="kicker red">{isSignup ? 'Open an account' : 'Return to your desk'}</div>
          <h2>{isSignup ? 'Sign up' : 'Sign in'}</h2>
          <div className="hr red auth-rule" />

          <form onSubmit={handleSubmit}>
            {isSignup ? (
              <div className="rfield">
                <label htmlFor="full-name">Full name</label>
                <input
                  id="full-name"
                  className="rinput"
                  type="text"
                  autoComplete="name"
                  maxLength={MAX_NAME_LENGTH}
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="the name you sign emails with"
                  required
                />
              </div>
            ) : null}

            <div className="rfield">
              <label htmlFor="email">Email address</label>
              <input
                id="email"
                className="rinput"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
              />
            </div>

            <div className="rfield">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                className="rinput"
                type="password"
                autoComplete={isSignup ? 'new-password' : 'current-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="at least eight characters"
                required
              />
            </div>

            {error ? (
              <p className="msg error" role="alert">
                {error}
              </p>
            ) : null}
            {notice ? <p className="msg notice">{notice}</p> : null}

            <button className="btn red block auth-submit" type="submit" disabled={busy}>
              {busy ? 'Working…' : isSignup ? 'Create account' : 'Enter'}
              <Icon name={busy ? 'loader' : 'arrow-right'} />
            </button>
          </form>

          <div className="auth-toggle">
            <button type="button" className="linkbtn" onClick={switchMode} disabled={busy}>
              {isSignup ? 'Already have an account →' : 'No account yet →'}
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
