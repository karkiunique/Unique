import { beforeAll, afterAll } from 'vitest';
import request from 'supertest';

/**
 * One listening server per test FILE, instead of one ephemeral port bind per request.
 *
 * WHY: `request(app)` with an Express app hands supertest a non-listening app, so it
 * binds a fresh ephemeral port for every single request. Across a suite that is
 * hundreds of binds per run, which is enough volume to turn a rare bind/connect race
 * into an intermittent `socket hang up` — or a request that never reaches the router
 * at all and comes back as an unexplained 404. Passing an already-listening server
 * makes supertest reuse its address and bind nothing.
 *
 * Safe with module-level `vi.mock`s: the app captures the mocked modules once at
 * import time, and the mock functions keep their identity across `mockReset()`, so
 * per-test mock setup still applies to a long-lived app instance.
 *
 * One thing to keep in mind when adopting this elsewhere: the app's rate limiter
 * (100 requests / 60s per IP) now counts across the whole file rather than resetting
 * per request. Files that make more than ~100 requests need their own server per
 * describe block instead.
 *
 * Adoptable by the other supertest suites in this directory when they are next
 * touched — no file needs to change until then.
 *
 * @param {Function} buildApp factory returning a configured Express app
 * @returns {(method: string, path: string) => import('supertest').Test}
 */
export function useSharedTestServer(buildApp) {
  let server = null;

  beforeAll(async () => {
    server = buildApp().listen(0);

    if (!server.listening) {
      await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
    }
  });

  // Runs even when a test failed, so a leaked handle cannot hold the port or hang the run.
  afterAll(async () => {
    const running = server;
    server = null;
    if (!running) return;

    // Node's global agent keeps sockets alive, and close() waits on open connections.
    running.closeAllConnections?.();
    await new Promise((resolve) => running.close(() => resolve()));
  });

  return function send(method, path) {
    if (!server) throw new Error('Test server is not running');

    return request(server)[method](path);
  };
}

/**
 * One listening server for ONE test, torn down as soon as that test finishes.
 *
 * WHY this exists alongside `useSharedTestServer`: a few tests assert what
 * `createApp()` did with the environment at CONSTRUCTION time — which origin CORS
 * captured, whether the dev router was mounted at all. Those cannot share a
 * file-level server, because it was built before the test set its variables. What
 * they also do not need is a fresh bind per REQUEST, which is what
 * `request(createApp())` costs: one ephemeral port per call, and the bind/connect
 * race that comes with it. A server per test is the smallest thing that keeps the
 * construction-time semantics intact.
 *
 * `buildApp` is invoked inside this call, so call it AFTER the test has set its env
 * vars — that ordering is the entire point of the tests using this.
 *
 * @param {Function} buildApp factory returning a configured Express app
 * @param {(send: (method: string, path: string) => import('supertest').Test) => Promise<unknown>} run
 * @returns {Promise<unknown>} whatever `run` resolves to
 */
export async function withFreshServer(buildApp, run) {
  const server = buildApp().listen(0);

  if (!server.listening) {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  }

  try {
    return await run((method, path) => request(server)[method](path));
  } finally {
    // Runs even when an assertion threw, so a leaked handle cannot hold the port
    // or hang the run.
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}
