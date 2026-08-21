import { useEffect, useRef, useState } from 'react';

import Icon from '../components/Icon.jsx';
import UMark from '../components/UMark.jsx';
import LandingSteps from '../components/LandingSteps.jsx';
import WaitlistJoin from '../components/WaitlistJoin.jsx';
import ScrollProgress from '../components/ScrollProgress.jsx';
import { navigateTo } from '../lib/navigate.js';
import { fetchWaitlistCount } from '../lib/waitlist.js';
import { useReveal, delay } from '../lib/useReveal.js';

/**
 * The public front page (Decisions, 2026-08-15).
 *
 * This is the first thing a stranger sees, and it renders with no session, no
 * Supabase call and no authenticated request. Sign-in is one click away in the
 * masthead and nowhere else — a password box is not an introduction to a product
 * nobody has heard of yet.
 */

const PROOF = [
  ['lock', <>Gmail read-only</>],
  ['pen-line', <>
    <UMark /> approve every send
  </>],
  ['eye-off', <>Never stored</>]
];

/** In-page anchor scroll, with a fallback for jsdom and older Safari. */
function scrollToSection(event, id) {
  event.preventDefault();
  const target = document.getElementById(id);
  target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
}

export default function LandingPage() {
  // NULL until the server answers. Starting at a number means the page paints one
  // figure and then visibly corrects itself, which reads as fabricated — it shows
  // the page had an opinion before it had data. The counter holds a neutral
  // placeholder instead, for the ~100ms a same-origin GET takes.
  const [count, setCount] = useState(null);

  /**
   * Has the server answered yet? The FIRST real answer replaces the placeholder
   * unconditionally; only updates after it are monotonic.
   *
   * Both halves are load-bearing and they pull against each other. Without the
   * monotonic rule a late mount-fetch can overwrite a completed join and count the
   * page down. Without the first-answer exception the placeholder becomes a FLOOR:
   * the counter starts at 88, `Math.max` refuses anything smaller, and a genuine
   * count of 6 is silently discarded — which is exactly what happened when the
   * baseline moved into the table and the server began returning raw row counts.
   */
  const answered = useRef(false);

  function applyCount(next) {
    if (!Number.isFinite(next)) return;

    if (!answered.current) {
      answered.current = true;
      setCount(next);
      return;
    }

    setCount((current) => (current === null ? next : Math.max(current, next)));
  }

  useEffect(() => {
    let active = true;

    fetchWaitlistCount().then((live) => {
      if (active) applyCount(live);
    });

    return () => {
      active = false;
    };
  }, []);

  // The hero is above the fold, so its cascade plays on load; everything below
  // waits for the reader to arrive at it.
  const revealRef = useReveal();

  return (
    <main className="lp" ref={revealRef}>
      <ScrollProgress />
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

      <div className="dateline" data-reveal>
        <span>No. 001 · The voice issue</span>
        <span>Outbound, in your own hand</span>
        <span>Private beta · 2026</span>
      </div>

      <section className="hero" data-reveal="rule-x">
        <div className="kicker red" data-reveal style={delay(60)}>
          The outreach dispatch
        </div>
        <h1 data-reveal="set" style={delay(140)}>
          We make outreach <em>easy</em>.
        </h1>
        <p className="sub" data-reveal style={delay(280)}>
          Unique learns how <UMark /> actually write, finds the right people, and warms up every
          cold email, so outreach sounds like <UMark /> not AI slop.
        </p>

        <div className="cta" data-reveal style={delay(380)}>
          <a className="btn-lite" href="#join" onClick={(e) => scrollToSection(e, 'join')}>
            Join the waitlist
            <Icon name="feather" />
          </a>
          <a className="linkbtn" href="#how" onClick={(e) => scrollToSection(e, 'how')}>
            See how it works ↓
          </a>
        </div>

        <div className="counter" data-reveal style={delay(460)}>
          <span className="dotpulse" aria-hidden="true" />
          {/* The box keeps its size either way, so nothing shifts when the number
              lands — a layout jump would be its own kind of tell. */}
          <b>{count === null ? <span className="counter-wait">···</span> : count}</b> already on
          the waitlist
        </div>

        <div className="proof" data-reveal style={delay(530)}>
          {PROOF.map(([icon, text]) => (
            <span className="p" key={text}>
              <Icon name={icon} className="red" /> {text}
            </span>
          ))}
        </div>
      </section>

      <div className="secbar" id="how">
        <h2 data-reveal>
          How it <em>works</em>
        </h2>
        <span className="kicker" data-reveal style={delay(90)}>
          Five moves · desk to reply
        </span>
      </div>

      <LandingSteps />

      <section className="join" id="join" data-reveal="wipe">
        <div className="kicker">Private beta · limited seats</div>
        <h2>
          Make your outreach <em>easy</em>.
        </h2>
        <p>
          Join the waitlist and we’ll open a seat on your desk. Connect Gmail, build your voice, and
          send your first warm letter.
        </p>
        <WaitlistJoin count={count} onJoined={applyCount} />
      </section>

      <footer className="lp-foot" data-reveal>
        <span>Unique · outbound in your own hand</span>
        <span>© 2026 · Private beta</span>
      </footer>
    </main>
  );
}
