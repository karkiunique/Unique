import { useEffect, useRef } from 'react';

/**
 * The ruling line: a hairline of editorial red across the top of the viewport,
 * drawn to however far down the page the reader has got.
 *
 * It is driven straight off scroll position with no easing of its own, because
 * it is an INDICATOR rather than an animation — it reports a fact the reader is
 * already creating. That is also why it is left alone under reduced motion,
 * where autonomous movement would not be.
 *
 * The write is coalesced into an animation frame: scroll events fire far faster
 * than the screen redraws, and a layout write per event is the classic way to
 * make a smooth page stutter.
 */
export default function ScrollProgress() {
  const lineRef = useRef(null);

  useEffect(() => {
    const line = lineRef.current;
    if (!line) return undefined;

    let frame = 0;

    function draw() {
      frame = 0;
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      // A page shorter than its viewport has no progress to report.
      const progress = scrollable > 0 ? window.scrollY / scrollable : 0;
      line.style.transform = `scaleX(${Math.min(Math.max(progress, 0), 1)})`;
    }

    function onScroll() {
      if (!frame) frame = window.requestAnimationFrame(draw);
    }

    draw();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  return <div className="rule-progress" ref={lineRef} aria-hidden="true" />;
}
