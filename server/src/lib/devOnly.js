/**
 * Gate for dev-only routes.
 *
 * Two conditions, both required, on purpose. NODE_ENV alone is too easy to get
 * wrong on a deploy platform (unset, 'prod', 'staging', clobbered by a build
 * step), so a production box must ALSO explicitly opt in — which it never will.
 * Belt and braces: getting one of them wrong is not enough to expose anything.
 *
 * Both vars are read lazily on every call and never cached at module load, so a
 * test (or a runtime change) can flip them between app instances.
 */
export function devRoutesEnabled() {
  if (process.env.NODE_ENV === 'production') return false;

  // Exact string match, never truthy-coercion: 'false', '0', '1' and 'TRUE'
  // must all leave dev routes off.
  return process.env.ENABLE_DEV_ROUTES === 'true';
}
