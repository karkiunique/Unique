import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The "drafts are ready" notification (CLAUDE.md, Decisions 2026-08-16).
 *
 * THE PROPERTY UNDER TEST is what this email is NOT allowed to contain. It carries
 * a count and a link. A draft body, a prospect's name, or a prospect's address in
 * here would route the user's prospect data and AI-drafted letters through
 * Postmark, which has no business holding them — the § Privacy rule that raw
 * bodies reach no third party except the Anthropic API.
 *
 * So the tests assert on the ABSENCE of that content and on the guard failing
 * loud, not merely on the happy path rendering nicely.
 */

const { sendSystemEmail } = vi.hoisted(() => ({ sendSystemEmail: vi.fn() }));

vi.mock('../src/lib/postmark.js', () => ({
  sendSystemEmail,
  isPostmarkConfigured: () => true
}));

const { notifyDraftsReady, buildDraftsReadyEmail, assertNoProspectContent } = await import(
  '../src/services/notify.js'
);

beforeEach(() => {
  sendSystemEmail.mockReset();
  sendSystemEmail.mockResolvedValue({ sent: true });
  process.env.APP_URL = 'https://app.example.com';
});

describe('buildDraftsReadyEmail', () => {
  it('says how many and where to go, and nothing else', () => {
    const { subject, textBody } = buildDraftsReadyEmail(2);

    expect(subject).toBe('2 drafts ready for review');
    expect(textBody).toContain('https://app.example.com/queue');
    expect(textBody).toContain('Nothing has been sent');
  });

  it('does not say "1 drafts"', () => {
    expect(buildDraftsReadyEmail(1).subject).toBe('1 draft ready for review');
  });

  it('carries no email address of any kind', () => {
    const { subject, textBody } = buildDraftsReadyEmail(2);

    expect(`${subject} ${textBody}`).not.toMatch(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  });

  it('stays short enough that it cannot be smuggling a letter', () => {
    expect(buildDraftsReadyEmail(2).textBody.length).toBeLessThan(600);
  });
});

describe('assertNoProspectContent — the guard, not the happy path', () => {
  it('throws on a prospect address', () => {
    expect(() => assertNoProspectContent('Reply to dana@k12district.org today')).toThrow(
      /email address/
    );
  });

  it('throws on something long enough to be a draft body', () => {
    expect(() => assertNoProspectContent('x'.repeat(601))).toThrow(/too long/);
  });

  it('lets a count and a link through', () => {
    expect(() => assertNoProspectContent('2 drafts ready. https://app.example.com/queue')).not.toThrow();
  });
});

describe('notifyDraftsReady', () => {
  it('sends to the user with the drafts-ready tag', async () => {
    await notifyDraftsReady('user@example.com', 3);

    expect(sendSystemEmail).toHaveBeenCalledTimes(1);
    const [payload] = sendSystemEmail.mock.calls[0];
    expect(payload.to).toBe('user@example.com');
    expect(payload.subject).toBe('3 drafts ready for review');
    expect(payload.tag).toBe('drafts-ready');
  });

  /**
   * The signature is the guard: this function takes a COUNT, never the leads. A
   * version that accepted the drafts could later be changed to include them.
   */
  it('accepts a count, never the leads themselves', () => {
    expect(notifyDraftsReady.length).toBe(2);
  });

  it('refuses to send for a count of zero — silence beats "0 drafts ready"', async () => {
    await expect(notifyDraftsReady('user@example.com', 0)).rejects.toThrow(/positive count/);
    expect(sendSystemEmail).not.toHaveBeenCalled();
  });

  it('refuses without a recipient', async () => {
    await expect(notifyDraftsReady('', 2)).rejects.toThrow();
    expect(sendSystemEmail).not.toHaveBeenCalled();
  });
});
