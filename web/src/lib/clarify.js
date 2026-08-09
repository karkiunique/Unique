import { api } from './api.js';

/**
 * The clarify pass's one call: from a campaign's brief, the questions it left
 * unanswered (CLAUDE.md, 2026-08-09).
 *
 * IT NEVER THROWS. By the time this runs the campaign already exists, and
 * drafting is never blocked on a question — so a model that failed, a network
 * that dropped, or a response of an unexpected shape all resolve to "no
 * questions" and the user moves on to their campaign.
 */
export async function fetchClarifyQuestions(campaignId) {
  try {
    const payload = await api.post(`/campaigns/${campaignId}/clarify`);
    const questions = Array.isArray(payload?.questions) ? payload.questions : [];

    return questions.filter((question) => typeof question === 'string' && question.trim() !== '');
  } catch {
    return [];
  }
}
