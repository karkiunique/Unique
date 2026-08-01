import Anthropic from '@anthropic-ai/sdk';

/**
 * Anthropic client. Created lazily (same pattern as lib/supabase.js) so importing
 * this module in tests or in `node --check` does not require ANTHROPIC_API_KEY.
 */
let client = null;

/** Pinned by CLAUDE.md ("do not substitute"). */
export const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

export function getAnthropic() {
  if (client) return client;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('Missing ANTHROPIC_API_KEY in the environment');
  }

  client = new Anthropic({ apiKey });

  return client;
}

/** Model id for a call. Overridable via env, but defaults to the pinned model. */
export function getModel() {
  return process.env.ANTHROPIC_MODEL || ANTHROPIC_MODEL;
}

/** Test helper: drop the memoized client so env changes take effect. */
export function resetAnthropic() {
  client = null;
}
