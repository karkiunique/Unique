import { describe, it, expect, vi } from 'vitest';

/**
 * Merge-variable substitution. This is the part of template mode that makes it
 * trustworthy: the values are spliced in HERE, in code, and a lead that cannot
 * fill a variable its template uses is failed rather than sent with a blank.
 */

vi.mock('../src/lib/supabase.js', () => ({
  getSupabaseAdmin: () => ({ from: vi.fn() }),
  resetSupabaseAdmin: () => {}
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  sanitizeMeta: (meta) => meta
}));

const {
  MERGE_FIELDS,
  findMergeVars,
  findMissingMergeVars,
  applyMergeVars,
  splitOnPersonalized,
  fillPersonalized
} = await import('../src/services/templateMerge.js');

const LEAD = {
  first_name: 'Marguerite',
  last_name: 'Okonjo',
  company: 'Blackwood Holdings',
  title: 'Head of Ops'
};

describe('findMergeVars', () => {
  it('returns the variables a template uses, deduped and in order', () => {
    const template = 'Hi {{first_name}}, about {{company}} — {{first_name}}, are you {{title}}?';

    expect(findMergeVars(template)).toEqual(['first_name', 'company', 'title']);
  });

  it('tolerates whitespace inside the braces', () => {
    expect(findMergeVars('Hi {{ first_name }},')).toEqual(['first_name']);
  });

  it('ignores {{personalized}} and anything that is not a merge variable', () => {
    expect(findMergeVars('{{personalized}} {{revenue}} {{last_name}}')).toEqual([]);
  });

  it('never claims a variable outside the supported set', () => {
    for (const field of findMergeVars('{{first_name}}{{company}}{{title}}')) {
      expect(MERGE_FIELDS).toContain(field);
    }
  });

  it('handles a missing or non-string template without throwing', () => {
    expect(findMergeVars(null)).toEqual([]);
    expect(findMergeVars(undefined)).toEqual([]);
    expect(findMergeVars(42)).toEqual([]);
  });
});

describe('findMissingMergeVars', () => {
  it('is empty when the lead can fill every variable', () => {
    expect(findMissingMergeVars('Hi {{first_name}} at {{company}}', LEAD)).toEqual([]);
  });

  it('flags null, undefined, empty and whitespace-only values alike', () => {
    const template = 'Hi {{first_name}} at {{company}}, {{title}}';
    const blanks = [
      { ...LEAD, company: null },
      { ...LEAD, company: undefined },
      { ...LEAD, company: '' },
      { ...LEAD, company: '   ' }
    ];

    for (const lead of blanks) {
      expect(findMissingMergeVars(template, lead)).toEqual(['company']);
    }
  });

  it('does not flag a variable the template never uses', () => {
    expect(findMissingMergeVars('Hi {{first_name}}', { ...LEAD, company: null })).toEqual([]);
  });
});

describe('applyMergeVars', () => {
  it('substitutes every supported variable and trims the value', () => {
    const merged = applyMergeVars('Hi {{first_name}} at {{ company }} ({{title}})', {
      ...LEAD,
      first_name: '  Marguerite  '
    });

    expect(merged).toBe('Hi Marguerite at Blackwood Holdings (Head of Ops)');
    expect(merged).not.toContain('{{');
  });

  it('leaves {{personalized}} and unknown tokens untouched', () => {
    const merged = applyMergeVars('{{personalized}} {{revenue}} {{first_name}}', LEAD);

    expect(merged).toBe('{{personalized}} {{revenue}} Marguerite');
  });

  it('accepts a numeric value from a CSV column', () => {
    expect(applyMergeVars('{{company}}', { company: 2024 })).toBe('2024');
  });
});

describe('splitOnPersonalized / fillPersonalized', () => {
  it('round-trips a single personalised gap', () => {
    const template = 'Hi there,\n\n{{personalized}}\n\nthanks,\nAna';
    const segments = splitOnPersonalized(template);

    expect(segments).toHaveLength(2);
    expect(fillPersonalized(segments, ['saw the raise'])).toBe(
      'Hi there,\n\nsaw the raise\n\nthanks,\nAna'
    );
  });

  it('round-trips two gaps in order', () => {
    const segments = splitOnPersonalized('A{{personalized}}B{{personalized}}C');

    expect(segments).toEqual(['A', 'B', 'C']);
    expect(fillPersonalized(segments, ['one', 'two'])).toBe('AoneBtwoC');
  });

  it('rebuilds the original template when there is no gap at all', () => {
    const segments = splitOnPersonalized('no gaps here');

    expect(segments).toHaveLength(1);
    expect(fillPersonalized(segments, [])).toBe('no gaps here');
  });
});
