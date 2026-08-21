import { useLayoutEffect, useRef } from 'react';

/**
 * Scroll-triggered reveals for the broadsheet pages (see motion.css).
 *
 * MOTION IS OPT-IN, AND THAT IS THE WHOLE SAFETY ARGUMENT. motion.css hides
 * nothing until this hook puts `motion-on` on the container, and it only does
 * that once it is holding an IntersectionObserver that can take the hiding back
 * off. So no-JS, no-observer, reduced-motion and jsdom all land on the same
 * resting state: the entire page visible. A landing page that hides its own
 * content behind a script that might not run has bet the introduction on the
 * script loading.
 *
 * Elements opt in with `data-reveal` rather than a ref each, so a component adds
 * one attribute and a delay and never touches this file.
 */

const REVEALED = 'is-in';

/* Fire a little after the element's top edge clears the fold, so a reveal reads
   as deliberate rather than as something racing the scroll.

   The inset is a FIXED 64px and not a percentage. A percentage scales with the
   viewport, and on a tall screen it grows into a band deep enough to strand the
   last element on the page — which is not a timing wobble but permanently
   invisible content. `threshold` is kept at effectively zero for the same
   reason: an element taller than the viewport can never reach a ratio like 0.15,
   so a "nicer" threshold would strand every long section. */
const OBSERVER_OPTIONS = { rootMargin: '0px 0px -64px 0px', threshold: 0.01 };

/** Has the reader hit the end of the document, give or take a rounding pixel? */
function atDocumentEnd() {
  const fromTop = window.innerHeight + window.scrollY;
  return fromTop >= document.documentElement.scrollHeight - 2;
}

/** Can this visitor, in this browser, be shown motion at all? */
export function motionAllowed() {
  if (typeof window === 'undefined') return false;
  if (typeof window.IntersectionObserver === 'undefined') return false;
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches !== true;
}

/**
 * Returns a ref for the container whose `[data-reveal]` descendants should
 * reveal as they come into view.
 */
export function useReveal() {
  const rootRef = useRef(null);

  // Layout effect, not effect: the class has to be on before the first paint, or
  // the page shows its resting state for a frame and then hides it to animate —
  // a flash of the very content the motion is meant to introduce.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !motionAllowed()) return undefined;

    root.classList.add('motion-on');

    const observer = new window.IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;

        entry.target.classList.add(REVEALED);
        // One way only. Replaying on the way back up turns a page a reader is
        // scanning into a slideshow they have to wait for.
        observer.unobserve(entry.target);
      }
    }, OBSERVER_OPTIONS);

    for (const element of root.querySelectorAll('[data-reveal]')) observer.observe(element);

    // The 64px inset means anything sitting in the last 64px of the document can
    // never satisfy the observer: the page runs out of scroll before the element
    // clears the inset, and it stays hidden for good. That is how the footer went
    // permanently invisible the first time this ran in a real browser. Once the
    // reader is at the end there is nothing further to wait for, so show whatever
    // is still holding — a backstop for the whole class, not a patch for the
    // footer.
    function revealRemainder() {
      if (!atDocumentEnd()) return;

      for (const element of root.querySelectorAll(`[data-reveal]:not(.${REVEALED})`)) {
        element.classList.add(REVEALED);
        observer.unobserve(element);
      }

      window.removeEventListener('scroll', revealRemainder);
    }

    window.addEventListener('scroll', revealRemainder, { passive: true });
    // A page that already fits its viewport is at its end on arrival.
    revealRemainder();

    return () => {
      window.removeEventListener('scroll', revealRemainder);
      observer.disconnect();
    };
  }, []);

  return rootRef;
}

/** Inline `--d`, the per-element stagger motion.css reads as its delay. */
export function delay(ms) {
  return { '--d': `${ms}ms` };
}
