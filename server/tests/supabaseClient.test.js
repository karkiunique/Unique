import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Deliberately NOT mocked: not `@supabase/supabase-js`, not `../src/lib/supabase.js`.
// Every other suite mocks this module, so the real `createClient` was never once
// invoked by the tests — which is how a hard startup crash (realtime-js needs a
// native WebSocket that Node 20 lacks) shipped past 166 green tests. This file
// exercises the real module. Construction only: no network calls anywhere.
import { getSupabaseAdmin, resetSupabaseAdmin } from '../src/lib/supabase.js';

const URL = 'https://example.supabase.co';
const SERVICE_ROLE_KEY = 'test-service-role-key';

let previousUrl;
let previousKey;

function restore(name, previous) {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

beforeEach(() => {
  previousUrl = process.env.SUPABASE_URL;
  previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
  resetSupabaseAdmin();
});

afterEach(() => {
  restore('SUPABASE_URL', previousUrl);
  restore('SUPABASE_SERVICE_ROLE_KEY', previousKey);
  resetSupabaseAdmin();
});

describe('getSupabaseAdmin', () => {
  it('constructs a client without throwing', () => {
    // THE REGRESSION TEST: without `realtime: { transport: ws }` this throws
    // "Node.js 20 detected without native WebSocket support" and every
    // authenticated request 500s with "Could not verify credentials".
    expect(() => getSupabaseAdmin()).not.toThrow();
  });

  it('returns a real client exposing .auth and .from', () => {
    const client = getSupabaseAdmin();

    expect(client).toBeTruthy();
    expect(client.auth).toBeTruthy();
    expect(typeof client.auth.getUser).toBe('function');
    expect(typeof client.from).toBe('function');
  });

  it('memoizes the client across calls', () => {
    expect(getSupabaseAdmin()).toBe(getSupabaseAdmin());
  });

  it('throws a clear error when SUPABASE_URL is missing', () => {
    delete process.env.SUPABASE_URL;
    resetSupabaseAdmin();

    expect(() => getSupabaseAdmin()).toThrow(/SUPABASE_URL/);
  });

  it('throws a clear error when SUPABASE_SERVICE_ROLE_KEY is missing', () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    resetSupabaseAdmin();

    expect(() => getSupabaseAdmin()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});

describe('resetSupabaseAdmin', () => {
  it('clears the memo so a later call builds a fresh client', () => {
    const first = getSupabaseAdmin();
    resetSupabaseAdmin();
    const second = getSupabaseAdmin();

    expect(second).not.toBe(first);
    expect(typeof second.from).toBe('function');
  });
});
