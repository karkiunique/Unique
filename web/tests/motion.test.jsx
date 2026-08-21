import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * The scroll motion layer (src/motion.css + src/lib/useReveal.js).
 *
 * ONE PROPERTY MATTERS MORE THAN THE EFFECT ITSELF: motion.css hides a
 * `[data-reveal]` element only inside a `.motion-on` container, and useReveal
 * adds that class only once it holds an observer that can take the hiding back
 * off. Get it backwards and the landing page — the page a stranger sees first —
 * is blank for anyone whose browser has no IntersectionObserver or who has asked
 * for reduced motion. The tests below assert the class is ABSENT in exactly
 * those cases, which is the assertion that fails if someone later moves the
 * hiding into a plain stylesheet rule.
 */

const { apiFetch, navigateTo, reloadPage } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  navigateTo: vi.fn(),
  reloadPage: vi.fn()
}));

vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  apiFetch
}));

vi.mock('../src/lib/navigate.js', () => ({
  navigateTo,
  reloadPage,
  getQueryParam: () => null
}));

const { default: LandingPage } = await import('../src/pages/LandingPage.jsx');
const { motionAllowed, delay } = await import('../src/lib/useReveal.js');

/** Stand-in for the real observer, so a test can decide when something scrolls in. */
const observers = [];
const unobserved = [];

class FakeIntersectionObserver {
  constructor(callback) {
    this.callback = callback;
    this.targets = new Set();
    observers.push(this);
  }

  observe(element) {
    this.targets.add(element);
  }

  unobserve(element) {
    this.targets.delete(element);
    unobserved.push(element);
  }

  disconnect() {
    this.targets.clear();
  }

  /** Scroll every observed element into view at once. */
  intersectAll() {
    const entries = [...this.targets].map((target) => ({ target, isIntersecting: true }));
    this.callback(entries);
  }
}

const originalObserver = window.IntersectionObserver;
const originalMatchMedia = window.matchMedia;

/* jsdom does no layout, so a document is zero-height unless a test says
   otherwise — which would make every page look like one that already fits its
   viewport. */
function setDocumentHeight(height) {
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    configurable: true,
    get: () => height
  });
}

function scrollTo(y) {
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => y });
  window.dispatchEvent(new Event('scroll'));
}

beforeEach(() => {
  observers.length = 0;
  unobserved.length = 0;
  apiFetch.mockReset();
  apiFetch.mockImplementation((path) =>
    path === '/waitlist/count' ? Promise.resolve({ count: 88 }) : Promise.resolve({})
  );
});

afterEach(() => {
  window.IntersectionObserver = originalObserver;
  window.matchMedia = originalMatchMedia;
  setDocumentHeight(0);
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => 0 });
});

function useReducedMotion(reduce) {
  window.matchMedia = vi.fn().mockReturnValue({ matches: reduce });
}

describe('motion is opt-in', () => {
  it('never arms the hiding when the browser has no IntersectionObserver', () => {
    // jsdom ships without one, which is the same position as an old browser or a
    // script that failed to load.
    delete window.IntersectionObserver;

    const { container } = render(<LandingPage />);

    expect(motionAllowed()).toBe(false);
    expect(container.querySelector('.motion-on')).toBeNull();
    // The page is still fully readable, which is the point of the whole design.
    expect(screen.getByRole('heading', { name: /We make outreach/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Track replies/ })).toBeInTheDocument();
  });

  it('never arms the hiding for a visitor who asked for reduced motion', () => {
    window.IntersectionObserver = FakeIntersectionObserver;
    useReducedMotion(true);

    const { container } = render(<LandingPage />);

    expect(motionAllowed()).toBe(false);
    expect(container.querySelector('.motion-on')).toBeNull();
    expect(observers).toHaveLength(0);
    expect(screen.getByRole('heading', { name: /We make outreach/ })).toBeInTheDocument();
  });
});

describe('reveals', () => {
  beforeEach(() => {
    window.IntersectionObserver = FakeIntersectionObserver;
    useReducedMotion(false);
    // Taller than the viewport, so there is genuinely something to scroll to.
    setDocumentHeight(5000);
  });

  it('arms the hiding and observes every marked element once it can undo it', () => {
    const { container } = render(<LandingPage />);

    expect(container.querySelector('.motion-on')).toBe(container.querySelector('.lp'));

    const marked = container.querySelectorAll('[data-reveal]');
    expect(marked.length).toBeGreaterThan(20);
    expect(observers).toHaveLength(1);
    expect(observers[0].targets.size).toBe(marked.length);

    // Nothing is revealed until it is actually scrolled to.
    expect(container.querySelectorAll('.is-in')).toHaveLength(0);
  });

  it('reveals on intersection and then stops watching, so nothing replays', () => {
    const { container } = render(<LandingPage />);
    const marked = container.querySelectorAll('[data-reveal]');

    observers[0].intersectAll();

    expect(container.querySelectorAll('.is-in')).toHaveLength(marked.length);
    // Unobserved on the way in: scrolling back up must not re-run the page.
    expect(unobserved).toHaveLength(marked.length);
    expect(observers[0].targets.size).toBe(0);
  });

  it('keeps the benchmark figures and their attribution through the reveal', () => {
    render(<LandingPage />);
    observers[0].intersectAll();

    // The bars animate by SCALING, so the width in the markup stays the figure.
    expect(screen.getByText('reply 3%')).toBeInTheDocument();
    expect(screen.getByText('reply 11%')).toBeInTheDocument();
    expect(screen.getByText(/Industry benchmarks/i)).toBeInTheDocument();
    expect(screen.queryByText(/41%/)).not.toBeInTheDocument();
  });
});

/**
 * REGRESSION: the footer was permanently invisible in a real browser.
 *
 * The observer's bottom inset means an element in the last few pixels of the
 * document can never satisfy it — the page runs out of scroll first. Every
 * unit test passed anyway, because jsdom reports a zero-height document and so
 * took the already-at-the-end path. These pin the backstop that fixes it.
 */
describe('nothing is left stranded at the end of the document', () => {
  beforeEach(() => {
    window.IntersectionObserver = FakeIntersectionObserver;
    useReducedMotion(false);
  });

  it('reveals whatever the observer could not reach once the reader hits the end', () => {
    setDocumentHeight(5000);
    const { container } = render(<LandingPage />);

    expect(container.querySelectorAll('.is-in')).toHaveLength(0);

    // Reaching the end WITHOUT the observer ever firing: exactly the position the
    // footer was stuck in.
    scrollTo(5000 - window.innerHeight);

    const marked = container.querySelectorAll('[data-reveal]');
    expect(container.querySelectorAll('.is-in')).toHaveLength(marked.length);
  });

  it('reveals immediately on a page that already fits its viewport', () => {
    setDocumentHeight(window.innerHeight);
    const { container } = render(<LandingPage />);

    const marked = container.querySelectorAll('[data-reveal]');
    expect(container.querySelectorAll('.is-in')).toHaveLength(marked.length);
  });
});

/**
 * REGRESSION: the waitlist block was permanently invisible in a real browser.
 *
 * It was hidden with `clip-path: inset(0 0 100% 0)`, which empties the element's
 * own intersection rectangle — so IntersectionObserver reported it as never
 * intersecting and the reveal that would have un-clipped it never ran. Hidden
 * because unrevealed, unrevealed because hidden.
 *
 * No runtime test can catch this: it needs real layout AND a real observer, and
 * jsdom has neither. A source check is the only guard available. If a pseudo-
 * element ever genuinely needs clipping, narrow this test rather than deleting
 * it — but never clip an element carrying `data-reveal`.
 */
describe('motion.css never clips an observed element', () => {
  it('hides nothing with clip-path', () => {
    // Read off disk. Importing it — even as `?raw` — gets a stub, because vitest
    // does not process CSS by default, and an empty string passes any `not`
    // assertion you care to write. That is how the first version of this test
    // came out green while the stylesheet it was guarding still had the bug.
    const css = readFileSync(resolve(process.cwd(), 'src/motion.css'), 'utf8');
    // Comments are prose and may name the technique; declarations may not use it.
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '');

    // Proof the file was actually read, so this can never go vacuous again.
    expect(declarations).toMatch(/\[data-reveal='wipe'\]/);
    expect(declarations).not.toMatch(/clip-path/);
  });
});

describe('delay', () => {
  it('emits the custom property motion.css reads as its stagger', () => {
    expect(delay(280)).toEqual({ '--d': '280ms' });
  });
});
