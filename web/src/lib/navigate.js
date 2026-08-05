/**
 * Full-page navigation, isolated in one place.
 *
 * `window.location` and its methods are unforgeable in the DOM spec, so they
 * cannot be spied on in jsdom. Routing every real navigation through this
 * function keeps tests able to assert on redirects without ever navigating.
 * There is no router in this app by design — see CLAUDE.md.
 */
export function navigateTo(url) {
  window.location.assign(url);
}

/** Query param off the current URL, or null. Read directly, no router. */
export function getQueryParam(name) {
  try {
    return new URLSearchParams(window.location.search || '').get(name);
  } catch {
    return null;
  }
}
