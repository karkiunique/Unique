import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { useSharedTestServer } from './helpers/testServer.js';
import { isSpaRequest, shouldNoIndex } from '../src/lib/webApp.js';

/**
 * Serving the built web app from the same origin as the API
 * (CLAUDE.md, Decisions 2026-08-19).
 *
 * THE HAZARD THIS FILE EXISTS FOR: a catch-all in front of a JSON API. If the SPA
 * fallback is ever allowed to match `/api/*`, an unmatched endpoint answers
 * `200 text/html` instead of `404 {"error"}` — and the caller then fails somewhere
 * far away from the typo that caused it. The ordering assertions below are the
 * guard, and they are on the RESPONSE TYPE, not just the status.
 */

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  sanitizeMeta: (meta) => meta
}));

/**
 * A stand-in for `web/dist`, built at MODULE SCOPE.
 *
 * `createApp()` reads the dist path once, at construction, and the shared test
 * server constructs the app in `beforeAll` — so a fixture created in `beforeEach`
 * does not exist yet when it matters and the static layer is silently skipped.
 */
const dist = mkdtempSync(join(tmpdir(), 'unique-dist-'));
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Unique</title><div id="root"></div>');
mkdirSync(join(dist, 'assets'), { recursive: true });
writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');

afterAll(() => {
  rmSync(dist, { recursive: true, force: true });
});

vi.mock('../src/lib/webApp.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, webDistPath: () => dist };
});

const { createApp } = await import('../src/app.js');

const httpRequest = useSharedTestServer(createApp);

describe('isSpaRequest — the ordering rule, in isolation', () => {
  it.each([
    ['GET', '/', true],
    ['GET', '/queue', true],
    ['GET', '/target', true],
    ['GET', '/signin', true],
    ['GET', '/u/some-token', true],
    ['HEAD', '/queue', true]
  ])('%s %s is the SPA', (method, path, expected) => {
    expect(isSpaRequest(method, path)).toBe(expected);
  });

  it.each([
    ['GET', '/api/queue'],
    ['GET', '/api'],
    ['GET', '/api/nope/deeply/nested'],
    ['POST', '/queue'],
    ['PATCH', '/leads/1'],
    ['DELETE', '/anything']
  ])('%s %s is NOT the SPA', (method, path) => {
    expect(isSpaRequest(method, path)).toBe(false);
  });
});

describe('the API keeps its own 404', () => {
  /**
   * The single most important assertion in this file. A regression here is silent
   * from the server's side and baffling from the client's.
   */
  it('answers an unmatched /api path with JSON, never the SPA shell', async () => {
    const response = await httpRequest('get', '/api/definitely-not-a-route');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/json/);
    expect(response.body).toEqual({ error: 'Not found' });
    expect(response.text).not.toContain('<!doctype html>');
  });

  it('answers a non-GET on an app path with JSON, not the shell', async () => {
    const response = await httpRequest('post', '/queue');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/json/);
  });

  it('still serves a real API route', async () => {
    const response = await httpRequest('get', '/api/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });
});

describe('the SPA shell', () => {
  it.each(['/', '/queue', '/target', '/signin', '/u/a-token'])(
    'serves index.html at %s so a cold deep link works',
    async (path) => {
      const response = await httpRequest('get', path);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/html/);
      expect(response.text).toContain('<div id="root">');
    }
  );

  it('serves a built asset as itself, not as the shell', async () => {
    const response = await httpRequest('get', '/assets/app.js');

    expect(response.status).toBe(200);
    expect(response.text).toBe('console.log(1)');
  });
});

describe('the CSP that decides whether the page renders', () => {
  it('allows the app’s own scripts, styles, fonts and Supabase', async () => {
    const csp = (await httpRequest('get', '/')).headers['content-security-policy'];

    expect(csp).toContain("script-src 'self'");
    // Style ATTRIBUTES are used for the landing page's bar widths.
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("font-src 'self'");
    // Sign-in talks to Supabase directly from the browser.
    expect(csp).toContain('https://*.supabase.co');
  });

  it('grants scripts no inline licence, whatever styles get', async () => {
    const csp = (await httpRequest('get', '/')).headers['content-security-policy'];

    const scriptSrc = csp.split(';').find((part) => part.trim().startsWith('script-src'));
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
  });
});

/**
 * INDEX THE FRONT PAGE, NOTHING ELSE.
 *
 * Every app route is served from the same index.html, so a `noindex` meta tag in
 * that file would hide the landing page too — which is exactly what it did until
 * now. The instruction has to come from a header, which can vary per request.
 */
describe('search-engine visibility', () => {
  it('marks every route except the landing page noindex', () => {
    expect(shouldNoIndex('/')).toBe(false);
    for (const p of ['/signin', '/queue', '/target', '/compose', '/threads', '/u/tok']) {
      expect(shouldNoIndex(p)).toBe(true);
    }
  });

  it('sends no X-Robots-Tag on the landing page', async () => {
    const response = await httpRequest('get', '/');

    expect(response.status).toBe(200);
    expect(response.headers['x-robots-tag']).toBeUndefined();
  });

  it.each(['/signin', '/queue', '/target', '/u/a-token'])('sends noindex on %s', async (path) => {
    const response = await httpRequest('get', path);

    expect(response.status).toBe(200);
    expect(response.headers['x-robots-tag']).toBe('noindex, nofollow');
  });
});
