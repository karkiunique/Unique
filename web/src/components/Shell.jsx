import { navigateTo } from '../lib/navigate.js';

/**
 * The broadsheet frame: masthead + section tabs, with the page rendered on the
 * canvas below. There is no router (CLAUDE.md), so tabs are full-page
 * navigations through lib/navigate.js.
 */

const SECTIONS = [
  { path: '/', label: 'Voice profile', numeral: 'I' },
  { path: '/compose', label: 'Compose', numeral: 'II' },
  { path: '/threads', label: 'Sent & replies', numeral: 'III' },
  { path: '/campaigns', label: 'Campaigns', numeral: 'IV' }
];

function todayLine() {
  return new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });
}

export function Shell({ email, path, children }) {
  return (
    <div className="paper-app">
      <header className="masthead">
        <div className="top">
          <div>
            <div className="kicker red">Cold email, in your own hand</div>
            <div className="wordmark">
              Unique<span className="dot">.</span>
            </div>
          </div>
          <div className="mast-meta">
            <div>{todayLine()}</div>
            <div>Desk of</div>
            <div className="desk">{email}</div>
          </div>
        </div>
        <nav className="navbar" aria-label="Sections">
          {SECTIONS.map((section) => {
            const active = section.path === path;
            return (
              <button
                key={section.path}
                type="button"
                className={active ? 'tab active' : 'tab'}
                aria-current={active ? 'page' : undefined}
                onClick={() => navigateTo(section.path)}
              >
                <span className="n">{section.numeral}</span>
                {section.label}
              </button>
            );
          })}
        </nav>
      </header>
      <div className="canvas">{children}</div>
    </div>
  );
}

/**
 * Kicker + title + optional sub and right-aligned aside.
 *
 * `title` is a React node, never an HTML string — wrap a word in <em> for the
 * italic-red emphasis, e.g. `title={<>The <em>register</em>.</>}`. Raw markup
 * is never injected here: that would put model- or user-derived text on a path
 * to the DOM parser.
 */
export function PageHead({ kicker, title, sub, aside }) {
  return (
    <div className="pagehead">
      <div className="rowline pagehead-row">
        <div>
          {kicker ? <div className="kicker">{kicker}</div> : null}
          <h1>{title}</h1>
          {sub ? <div className="sub">{sub}</div> : null}
        </div>
        {aside ?? null}
      </div>
    </div>
  );
}
