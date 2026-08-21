/**
 * "U." — the wordmark standing in for the word "you".
 *
 * The pun the brand is built on: the letter is both the reader and the product,
 * and the red period is the same one that ends "Unique." in the masthead.
 *
 * ONE ELEMENT, NOT TWO. The obvious accessible pattern — a visible aria-hidden
 * mark beside a visually-hidden "you" — puts both strings in the DOM, so the
 * sentence reads "U.you wrote them" to anything that walks text content. That
 * includes the clipboard: copying a paragraph would duplicate every word.
 *
 * `role="img"` with `aria-label` gives the glyph an accessible name without a
 * second copy of the word. Screen readers announce "you"; the clipboard gets "U.".
 *
 * Deliberately NOT used for "your", "you're", an email placeholder, or anything in
 * uppercase mono — "Ur" is text-message shorthand, and a serif mark inside 11px
 * mono sits off the baseline and reads as a rendering fault.
 */
export default function UMark() {
  return (
    <span className="umark" role="img" aria-label="you">
      U<span className="umark-dot">.</span>
    </span>
  );
}
