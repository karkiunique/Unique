import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The clarify pass's one call.
 *
 * Its whole contract is that it CANNOT throw: by the time it runs the campaign
 * already exists, and drafting is never blocked on a question (CLAUDE.md,
 * 2026-08-09). A failure has to land as "no questions", never as an error that
 * strands the user on the builder with a campaign they cannot see.
 */

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));

vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: apiPost, patch: vi.fn() },
  apiFetch: vi.fn()
}));

const { fetchClarifyQuestions } = await import('../src/lib/clarify.js');

const QUESTIONS = ['Who should reply?', 'What is the ask?'];

beforeEach(() => {
  apiPost.mockReset();
});

describe('fetchClarifyQuestions', () => {
  it('asks the campaign for its questions and returns them', async () => {
    apiPost.mockResolvedValue({ campaignId: 'c-9', questions: QUESTIONS });

    await expect(fetchClarifyQuestions('c-9')).resolves.toEqual(QUESTIONS);
    expect(apiPost).toHaveBeenCalledWith('/campaigns/c-9/clarify');
  });

  it('drops blanks and anything that is not a string', async () => {
    apiPost.mockResolvedValue({ questions: ['Who should reply?', '', '   ', 7, null, {}] });

    await expect(fetchClarifyQuestions('c-9')).resolves.toEqual(['Who should reply?']);
  });

  it('returns nothing rather than throwing when the request fails', async () => {
    const err = new Error('The model did not return usable questions');
    err.status = 502;
    apiPost.mockRejectedValue(err);

    await expect(fetchClarifyQuestions('c-9')).resolves.toEqual([]);
  });

  it('returns nothing on a response of an unexpected shape', async () => {
    for (const payload of [null, {}, { questions: 'who should reply?' }]) {
      apiPost.mockResolvedValue(payload);

      await expect(fetchClarifyQuestions('c-9')).resolves.toEqual([]);
    }
  });
});
