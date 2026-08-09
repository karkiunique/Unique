import { describe, it, expect } from 'vitest';

/**
 * What the model is told the campaign is FOR.
 *
 * This is the function that produced six letters about running a first test: it
 * fell back to `campaign.name` because no brief column existed. The order of
 * precedence below — explicit goal, then brief, then name — is the fix, and each
 * step of it is pinned here rather than only end-to-end through the batch.
 *
 * No mocks: this is pure assembly with no I/O, and it is worth keeping that way.
 */

const { campaignGoal } = await import('../src/services/campaignGoal.js');

const BRIEF =
  'We run payroll for Nordic shipping firms. Blackwood just bought two fleets and their ' +
  'finance team is still on manual timesheets.';

const CAMPAIGN = {
  name: 'First test',
  brief: null,
  clarifications: null,
  subject_template: null
};

describe('campaignGoal', () => {
  it('is the brief when there is one, and the name does not appear at all', () => {
    const goal = campaignGoal({ ...CAMPAIGN, brief: BRIEF });

    expect(goal).toContain(BRIEF);
    expect(goal).not.toContain('First test');
  });

  it('falls back to the campaign name when there is no brief', () => {
    expect(campaignGoal({ ...CAMPAIGN, name: 'Series A outreach' })).toContain(
      'Series A outreach'
    );
    expect(campaignGoal({ ...CAMPAIGN, name: 'Series A outreach', brief: '   ' })).toContain(
      'Series A outreach'
    );
  });

  it('falls back again when a campaign has neither, rather than returning nothing', () => {
    expect(campaignGoal({})).toBe('a short cold outreach email');
    expect(campaignGoal(null)).toBe('a short cold outreach email');
  });

  it('prefers an explicit per-run goal over both the brief and the name', () => {
    const goal = campaignGoal(
      { ...CAMPAIGN, name: 'Series A outreach', brief: BRIEF },
      '  book a 15 minute demo  '
    );

    expect(goal).toBe('book a 15 minute demo');
  });

  it("carries the user's own subject line through", () => {
    const goal = campaignGoal({ ...CAMPAIGN, brief: BRIEF, subject_template: 'about your fleets' });

    expect(goal).toContain('The subject line is: about your fleets');
  });
});

describe('campaignGoal — the clarify pass', () => {
  const CLARIFIED = {
    ...CAMPAIGN,
    brief: BRIEF,
    clarifications: [
      { question: 'Who should reply?', answer: 'the head of finance' },
      { question: 'What proof do you have?', answer: null },
      { question: 'What is the ask?', answer: '   ' },
      { question: '   ', answer: 'an answer to nothing' },
      { question: 'What do they get?', answer: 'their month-end close cut to two days' }
    ]
  };

  it('adds every answered question to the goal', () => {
    const goal = campaignGoal(CLARIFIED);

    expect(goal).toContain('Q: Who should reply?\nA: the head of finance');
    expect(goal).toContain('Q: What do they get?\nA: their month-end close cut to two days');
  });

  /**
   * A skip is a first-class outcome (CLAUDE.md, 2026-08-09). A dangling
   * "Q: ... A: null" tells the model there is nothing there, which is worse than
   * never having asked.
   */
  it('leaves out the skipped ones entirely — no null, no empty answer', () => {
    const goal = campaignGoal(CLARIFIED);

    expect(goal).not.toContain('What proof do you have?');
    expect(goal).not.toContain('What is the ask?');
    expect(goal).not.toContain('an answer to nothing');
    expect(goal).not.toContain('null');
    expect(goal).not.toContain('undefined');
    expect(goal).not.toContain('A: \n');
  });

  it('adds nothing at all when every question was skipped', () => {
    const skipped = campaignGoal({
      ...CAMPAIGN,
      brief: BRIEF,
      clarifications: [
        { question: 'Who should reply?', answer: null },
        { question: 'What is the ask?', answer: null }
      ]
    });

    expect(skipped).toBe(campaignGoal({ ...CAMPAIGN, brief: BRIEF }));
  });

  it('survives clarifications of the wrong shape without throwing', () => {
    for (const clarifications of ['nope', 42, {}, [null], [{}], [7]]) {
      expect(campaignGoal({ ...CAMPAIGN, brief: BRIEF, clarifications })).toContain(BRIEF);
    }
  });
});
