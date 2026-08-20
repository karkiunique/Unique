import { describe, it, expect } from 'vitest';

import {
  screenCandidate,
  passesFidelityGate,
  screeningBudget,
  GATE,
  FIDELITY_FLOOR
} from '../src/services/leadGates.js';

/**
 * The eight gates (CLAUDE.md, Decisions 2026-08-16).
 *
 * The thing under test is not "does it filter" but "does it refuse". Every gate
 * here exists to keep a weak lead OUT of a two-a-day queue, and the failure mode
 * that matters is a gate quietly passing something it should have stopped.
 *
 * Each gate gets a test that fails ONLY that gate, so a gate that stops running
 * cannot hide behind another one rejecting the same fixture.
 */

const TARGET = {
  titles: ['head of', 'director'],
  seniority: ['director', 'vp'],
  industries: ['education'],
  company_size: '11-50',
  geos: ['united states'],
  exclude_domains: ['competitor.com'],
  exclude_industries: ['gambling'],
  daily_target: 2
};

function solidCandidate(overrides = {}) {
  return {
    email: 'dana@k12district.org',
    title: 'Director of Technology',
    seniority: 'director',
    industry: 'Education',
    company_size: '11-50',
    geo: 'United States',
    verification: { status: 'deliverable' },
    research: {
      hooks: ['They rolled out 1:1 Chromebooks across twelve schools last September.']
    },
    ...overrides
  };
}

const EMPTY_CONTEXT = { existingEmails: new Set(), unsubscribedEmails: new Set() };

describe('screenCandidate — the baseline', () => {
  it('passes a candidate that clears every gate', () => {
    expect(screenCandidate(solidCandidate(), TARGET, EMPTY_CONTEXT)).toEqual({
      passed: true,
      failedGate: null
    });
  });
});

describe('gate 1 — deliverable', () => {
  it.each([
    ['catch_all', 'catch_all'],
    ['unknown', 'unknown'],
    ['risky', 'risky'],
    ['undeliverable', 'undeliverable']
  ])('refuses a %s verdict — a bounce lands on the user’s own reputation', (_label, status) => {
    const result = screenCandidate(
      solidCandidate({ verification: { status } }),
      TARGET,
      EMPTY_CONTEXT
    );

    expect(result).toEqual({ passed: false, failedGate: GATE.DELIVERABLE });
  });

  it('refuses when there is no verdict at all — silence is not a pass', () => {
    const result = screenCandidate(solidCandidate({ verification: undefined }), TARGET, EMPTY_CONTEXT);

    expect(result.failedGate).toBe(GATE.DELIVERABLE);
  });
});

describe('gate 2 — role inboxes', () => {
  it.each(['info@k12district.org', 'sales@k12district.org', 'support@k12district.org'])(
    'refuses %s',
    (email) => {
      const result = screenCandidate(solidCandidate({ email }), TARGET, EMPTY_CONTEXT);

      expect(result.failedGate).toBe(GATE.ROLE_INBOX);
    }
  );

  it('sees through a plus-tag', () => {
    const result = screenCandidate(
      solidCandidate({ email: 'info+leads@k12district.org' }),
      TARGET,
      EMPTY_CONTEXT
    );

    expect(result.failedGate).toBe(GATE.ROLE_INBOX);
  });
});

describe('gates 3 and 4 — already known', () => {
  it('refuses someone already in the user’s leads', () => {
    const result = screenCandidate(solidCandidate(), TARGET, {
      ...EMPTY_CONTEXT,
      existingEmails: new Set(['dana@k12district.org'])
    });

    expect(result.failedGate).toBe(GATE.DUPLICATE);
  });

  it('refuses someone who unsubscribed, and matches case-insensitively', () => {
    const result = screenCandidate(solidCandidate({ email: 'DANA@K12District.org' }), TARGET, {
      ...EMPTY_CONTEXT,
      unsubscribedEmails: new Set(['dana@k12district.org'])
    });

    expect(result.failedGate).toBe(GATE.UNSUBSCRIBED);
  });
});

describe('gates 5 and 6 — the ICP', () => {
  it('refuses a title outside the target', () => {
    const result = screenCandidate(
      solidCandidate({ title: 'Substitute Teacher', seniority: 'individual' }),
      TARGET,
      EMPTY_CONTEXT
    );

    expect(result.failedGate).toBe(GATE.ROLE_MATCH);
  });

  it('refuses an industry outside the target', () => {
    const result = screenCandidate(
      solidCandidate({ industry: 'Logistics' }),
      TARGET,
      EMPTY_CONTEXT
    );

    expect(result.failedGate).toBe(GATE.COMPANY_MATCH);
  });

  it('refuses an excluded domain however well it otherwise matches', () => {
    const result = screenCandidate(
      solidCandidate({ email: 'dana@competitor.com' }),
      TARGET,
      EMPTY_CONTEXT
    );

    expect(result.failedGate).toBe(GATE.COMPANY_MATCH);
  });

  it('refuses a subdomain of an excluded domain', () => {
    const result = screenCandidate(
      solidCandidate({ email: 'dana@eu.competitor.com' }),
      TARGET,
      EMPTY_CONTEXT
    );

    expect(result.failedGate).toBe(GATE.COMPANY_MATCH);
  });

  it('refuses an excluded industry — exclusions beat inclusions', () => {
    const result = screenCandidate(
      solidCandidate({ industry: 'Education and Gambling' }),
      TARGET,
      EMPTY_CONTEXT
    );

    expect(result.failedGate).toBe(GATE.COMPANY_MATCH);
  });

  /**
   * SPARSE TARGET (CLAUDE.md § Rules). A user who names no industries has not said
   * "no industry qualifies" — they have said nothing about industry. Treating an
   * absent criterion as a rejection would make a thin ICP deliver zero leads
   * forever, which is the sparse-profile failure the platform rule forbids.
   */
  it('treats an absent criterion as no constraint, not as matching nothing', () => {
    const sparse = { titles: ['director'], daily_target: 2 };

    const result = screenCandidate(
      solidCandidate({ industry: 'Anything At All', geo: 'Somewhere', company_size: '5000+' }),
      sparse,
      EMPTY_CONTEXT
    );

    expect(result.passed).toBe(true);
  });

  it('still applies the other gates under a sparse target', () => {
    const sparse = { daily_target: 2 };

    const result = screenCandidate(
      solidCandidate({ research: { hooks: [] } }),
      sparse,
      EMPTY_CONTEXT
    );

    expect(result.failedGate).toBe(GATE.HOOK);
  });
});

describe('gate 7 — the personalization hook', () => {
  it('refuses a candidate with no hooks at all', () => {
    const result = screenCandidate(
      solidCandidate({ research: { hooks: [] } }),
      TARGET,
      EMPTY_CONTEXT
    );

    expect(result.failedGate).toBe(GATE.HOOK);
  });

  it('refuses a candidate with no research at all', () => {
    const result = screenCandidate(solidCandidate({ research: undefined }), TARGET, EMPTY_CONTEXT);

    expect(result.failedGate).toBe(GATE.HOOK);
  });

  /**
   * The shapes a research call returns when it found nothing. These are what a
   * generic letter gets written from, so they must not count as a hook.
   */
  it.each([['growth'], ['AI'], ['education'], ['a school']])(
    'refuses %j as too thin to personalize on',
    (hook) => {
      const result = screenCandidate(
        solidCandidate({ research: { hooks: [hook] } }),
        TARGET,
        EMPTY_CONTEXT
      );

      expect(result.failedGate).toBe(GATE.HOOK);
    }
  );

  it('accepts one specific hook among several thin ones', () => {
    const result = screenCandidate(
      solidCandidate({
        research: { hooks: ['AI', 'growth', 'They opened a second campus in Fresno in March.'] }
      }),
      TARGET,
      EMPTY_CONTEXT
    );

    expect(result.passed).toBe(true);
  });
});

describe('gate 8 — fidelity BLOCKS here, it does not flag', () => {
  it(`refuses anything below ${FIDELITY_FLOOR}`, () => {
    expect(passesFidelityGate(79)).toBe(false);
    expect(passesFidelityGate(0)).toBe(false);
  });

  it('accepts the floor exactly', () => {
    expect(passesFidelityGate(FIDELITY_FLOOR)).toBe(true);
  });

  it('refuses a missing or non-numeric score — unscored is not passing', () => {
    expect(passesFidelityGate(undefined)).toBe(false);
    expect(passesFidelityGate(null)).toBe(false);
    expect(passesFidelityGate(NaN)).toBe(false);
    expect(passesFidelityGate('95')).toBe(false);
  });
});

describe('screeningBudget', () => {
  it('screens roughly ten times what it hopes to deliver', () => {
    expect(screeningBudget(2)).toBe(20);
    expect(screeningBudget(1)).toBe(10);
  });

  it('caps so a pathological ICP cannot run up an unbounded bill', () => {
    expect(screeningBudget(5)).toBe(30);
    expect(screeningBudget(9999)).toBe(30);
  });

  it('falls back to the default rather than screening zero candidates', () => {
    expect(screeningBudget(undefined)).toBe(20);
    expect(screeningBudget(0)).toBe(20);
  });
});
