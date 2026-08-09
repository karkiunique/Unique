/**
 * What the model is told this campaign is FOR (CLAUDE.md §3, migration 004).
 *
 * Kept in its own module because it is the one input that decides what a letter
 * is about, as opposed to how it sounds — and because it got this wrong once
 * already, expensively: with no brief column, the goal fell back to the campaign
 * NAME, so a campaign called "First test" produced six letters about running a
 * first test.
 *
 * Nothing here logs. A brief and its answers are user-authored content about the
 * user's own business, treated exactly like a template body under
 * CLAUDE.md § Privacy: they go to the Anthropic API and nowhere else.
 */

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The clarify pass's answers, as prompt lines.
 *
 * A SKIPPED QUESTION CARRIES A NULL ANSWER and is dropped whole (CLAUDE.md,
 * 2026-08-09). An unanswered question left in the prompt with an empty answer
 * would read to the model as "there is nothing there" rather than "we did not
 * ask" — and drafting must never be blocked on a skip.
 */
function answeredClarifications(clarifications) {
  if (!Array.isArray(clarifications)) return [];

  const lines = [];
  for (const entry of clarifications) {
    const question = trimmed(entry?.question);
    const answer = trimmed(entry?.answer);
    if (question === '' || answer === '') continue;

    lines.push(`Q: ${question}\nA: ${answer}`);
  }

  return lines;
}

/**
 * The user's stated goal for this run: their BRIEF, plus whatever the clarify
 * pass got answered.
 *
 * The campaign NAME is only the fallback, for a campaign written before the
 * brief column existed or created without one. A weak goal beats none, but it is
 * the last resort and not the input.
 *
 * A per-run goal from the caller wins over both: it is the most explicit thing
 * anyone has said about this particular run.
 */
export function campaignGoal(campaign, requested) {
  const asked = trimmed(requested);
  if (asked !== '') return asked;

  const parts = [
    trimmed(campaign?.brief) || trimmed(campaign?.name) || 'a short cold outreach email'
  ];
  if (trimmed(campaign?.subject_template) !== '') {
    parts.push(`The subject line is: ${campaign.subject_template}`);
  }

  const answered = answeredClarifications(campaign?.clarifications);
  if (answered.length > 0) parts.push(`What else they told us:\n${answered.join('\n')}`);

  return parts.join('. ');
}
