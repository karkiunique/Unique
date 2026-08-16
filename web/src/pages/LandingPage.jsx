import { useEffect, useState } from 'react';

import Icon from '../components/Icon.jsx';
import LandingSteps from '../components/LandingSteps.jsx';
import WaitlistJoin from '../components/WaitlistJoin.jsx';
import { navigateTo } from '../lib/navigate.js';
import { fetchWaitlistCount, WAITLIST_BASE_COUNT } from '../lib/waitlist.js';

/**
 * The public front page (Decisions, 2026-08-15).
 *
 * This is the first thing a stranger sees, and it renders with no session, no
 * Supabase call and no authenticated request. Sign-in is one click away in the
 * masthead and nowhere else — a password box is not an introduction to a product
 * nobody has heard of yet.
 */

const PROOF = [
  ['lock', 'Gmail read-only'],
  ['pen-line', 'You approve every send'],
  ['eye-off', 'Never stored']
];

/** In-page anchor scroll, with a fallback for jsdom and older Safari. */
function scrollToSection(event, id) {
  event.preventDefault();
  const target = document.getElementById(id);
  target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
}

export default function LandingPage() {
  // Starts at the base rather than at zero or a spinner: the counter is furniture,
  // and a flash of "0 already on the waitlist" reads worse than a number that
  // refines itself a moment later.
  const [count, setCount] = useState(WAITLIST_BASE_COUNT);

  /**
   * The counter only ever goes up.
   *
   * Two things can otherwise walk it backwards. The mount fetch can resolve AFTER
   * a join and overwrite the new count with the value it read before it — a
   * one-off ordering race that the `active` flag does not cover, because that flag
   * only guards unmount. And any future caller handing back a stale or junk number
   * would drag the display down with it.
   *
   * A waitlist counter that ticks down in front of a visitor reads as broken, so
   * the monotonicity is enforced here rather than assumed of every caller.
   */
  function raiseCount(next) {
    setCount((current) => (Number.isFinite(next) ? Math.max(current, next) : current));
  }

  useEffect(() => {
    let active = true;

    fetchWaitlistCount().then((live) => {
      if (active) raiseCount(live);
    });

    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="lp">
      <header className="lp-mast">
        <div className="wordmark">
          Unique<span className="dot">.</span>
        </div>
        <div className="rt">
          <button type="button" className="linkbtn" onClick={() => navigateTo('/signin')}>
            Sign in
          </button>
          <a className="btn-lite" href="#join" onClick={(e) => scrollToSection(e, 'join')}>
            Join the waitlist
            <Icon name="arrow-right" />
          </a>
        </div>
      </header>

      <div className="dateline">
        <span>No. 001 · The voice issue</span>
        <span>Outbound, in your own hand</span>
        <span>Private beta · 2026</span>
      </div>

      <section className="hero">
        <div className="kicker red">The outreach dispatch</div>
        <h1>
          We make outreach <em>easy</em>.
        </h1>
        <p className="sub">
          Unique learns how you actually write, finds the right people, and warms up every cold
          email, so outreach sounds like you, not AI slop.
        </p>

        <div className="cta">
          <a className="btn-lite" href="#join" onClick={(e) => scrollToSection(e, 'join')}>
            Join the waitlist
            <Icon name="feather" />
          </a>
          <a className="linkbtn" href="#how" onClick={(e) => scrollToSection(e, 'how')}>
            See how it works ↓
          </a>
        </div>

        <div className="counter">
          <span className="dotpulse" aria-hidden="true" />
          <b>{count}</b> already on the waitlist
        </div>

        <div className="proof">
          {PROOF.map(([icon, text]) => (
            <span className="p" key={text}>
              <Icon name={icon} className="red" /> {text}
            </span>
          ))}
        </div>
      </section>

      <div className="secbar" id="how">
        <h2>
          How it <em>works</em>
        </h2>
        <span className="kicker">Five moves · desk to reply</span>
      </div>

      <LandingSteps />

      <section className="join" id="join">
        <div className="kicker">Private beta · limited seats</div>
        <h2>
          Make your outreach <em>easy</em>.
        </h2>
        <p>
          Join the waitlist and we’ll open a seat on your desk. Connect Gmail, build your voice, and
          send your first warm letter.
        </p>
        <WaitlistJoin count={count} onJoined={raiseCount} />
      </section>

      <footer className="lp-foot">
        <span>Unique · outbound in your own hand</span>
        <span>© 2026 · Private beta</span>
      </footer>
    </main>
  );
}
