import { describe, it, expect, vi, beforeEach } from 'vitest';

const { resolveMx } = vi.hoisted(() => ({ resolveMx: vi.fn() }));

// No real DNS in tests. Both specifiers are mocked so the service can import
// either form without the suite silently going to a live resolver.
vi.mock('node:dns/promises', () => ({ resolveMx }));
vi.mock('dns/promises', () => ({ resolveMx }));

const {
  verifyRecipient,
  resetMxCache,
  DNS_TIMEOUT_MS,
  VERIFY_REASON,
  ROLE_LOCAL_PARTS,
  DISPOSABLE_DOMAINS
} = await import('../src/services/recipientCheck.js');

const MX_RECORDS = [{ exchange: 'aspmx.l.google.com', priority: 10 }];
const KNOWN_REASONS = new Set(Object.values(VERIFY_REASON));

function withMx() {
  resolveMx.mockResolvedValue(MX_RECORDS);
}

function dnsError(code) {
  // Real resolver errors quote the hostname; the service must read the code and
  // drop the rest.
  const err = new Error(`queryMx ${code} corp.com`);
  err.code = code;
  return err;
}

beforeEach(() => {
  // restoreMocks:true wipes implementations between tests.
  resolveMx.mockReset();
  resetMxCache();
});

describe('verifyRecipient — syntax', () => {
  it('flags a malformed address without ever asking DNS', async () => {
    const malformed = ['not-an-email', 'sam@', '@corp.com', 'sam@corp', 'sam corp@x.com', ''];

    for (const address of malformed) {
      const result = await verifyRecipient(address);

      expect(result).toEqual({ status: 'invalid', reasons: ['syntax'], hasMx: false });
    }

    // Nothing resolvable, so nothing is resolved.
    expect(resolveMx).not.toHaveBeenCalled();
  });

  it('treats a non-string input as malformed rather than throwing', async () => {
    for (const value of [undefined, null, 42, {}, ['sam@corp.com']]) {
      await expect(verifyRecipient(value)).resolves.toEqual({
        status: 'invalid',
        reasons: ['syntax'],
        hasMx: false
      });
    }

    expect(resolveMx).not.toHaveBeenCalled();
  });
});

describe('verifyRecipient — MX', () => {
  it('returns ok when the domain has MX records and nothing else is flagged', async () => {
    withMx();

    const result = await verifyRecipient('sam@corp.com');

    expect(result).toEqual({ status: 'ok', reasons: [], hasMx: true });
    expect(resolveMx).toHaveBeenCalledWith('corp.com');
  });

  it('reads ENOTFOUND as a domain that provably cannot receive mail', async () => {
    resolveMx.mockRejectedValue(dnsError('ENOTFOUND'));

    const result = await verifyRecipient('sam@corp.com');

    expect(result).toEqual({ status: 'invalid', reasons: ['no_mx'], hasMx: false });
  });

  it('reads NXDOMAIN the same way', async () => {
    resolveMx.mockRejectedValue(dnsError('NXDOMAIN'));

    const result = await verifyRecipient('sam@corp.com');

    expect(result.status).toBe('invalid');
    expect(result.reasons).toEqual(['no_mx']);
  });

  it('reads an empty MX record set as no_mx', async () => {
    resolveMx.mockResolvedValue([]);

    const result = await verifyRecipient('sam@corp.com');

    expect(result).toEqual({ status: 'invalid', reasons: ['no_mx'], hasMx: false });
  });

  it('reads RFC 7505 null MX (a lone ".") as no_mx', async () => {
    resolveMx.mockResolvedValue([{ exchange: '.', priority: 0 }]);

    const result = await verifyRecipient('sam@corp.com');

    expect(result.status).toBe('invalid');
    expect(result.reasons).toEqual(['no_mx']);
  });

  it('lowercases the domain before resolving', async () => {
    withMx();

    await verifyRecipient('  Sam@CORP.com  ');

    expect(resolveMx).toHaveBeenCalledWith('corp.com');
  });
});

/**
 * The one that matters most. A slow or unreachable resolver says nothing about
 * the address — condemning a good address on a DNS hiccup would cost the user a
 * real prospect for our infrastructure's problem.
 */
describe('verifyRecipient — a failed lookup is never a bad address', () => {
  it('resolves to unknown, NOT invalid, when the lookup times out', async () => {
    // Never settles: the bounded race is the only way out.
    resolveMx.mockReturnValue(new Promise(() => {}));

    const result = await verifyRecipient('sam@corp.com', { timeoutMs: 1 });

    expect(result.status).toBe('unknown');
    expect(result.status).not.toBe('invalid');
    expect(result.reasons).toEqual(['dns_timeout']);
    expect(result.hasMx).toBe(false);
  });

  it('keeps the default timeout bounded and short', () => {
    expect(Number.isFinite(DNS_TIMEOUT_MS)).toBe(true);
    expect(DNS_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DNS_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });

  it('does not cache a timeout — the next lookup gets a clean answer', async () => {
    resolveMx.mockReturnValueOnce(new Promise(() => {}));

    const timedOut = await verifyRecipient('sam@corp.com', { timeoutMs: 1 });
    expect(timedOut.status).toBe('unknown');

    withMx();
    const retried = await verifyRecipient('sam@corp.com');

    expect(retried.status).toBe('ok');
  });

  it('resolves to unknown, NOT invalid, for any unexpected DNS error', async () => {
    for (const code of ['ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED', 'ENODATA', 'EREFUSED']) {
      resetMxCache();
      resolveMx.mockRejectedValue(dnsError(code));

      const result = await verifyRecipient('sam@corp.com');

      expect(result.status).toBe('unknown');
      expect(result.status).not.toBe('invalid');
      expect(result.reasons).toEqual(['dns_error']);
      expect(result.hasMx).toBe(false);
    }
  });

  it('resolves to unknown when the resolver answers with something that is not a record list', async () => {
    // Node's resolveMx always resolves to an array or rejects, so this cannot
    // happen today. It is pinned anyway because the other reading — "no usable
    // exchange, therefore no_mx" — would condemn a live domain as invalid off
    // the back of a resolver that told us nothing.
    for (const answer of [undefined, null, {}, 'aspmx.l.google.com']) {
      resetMxCache();
      resolveMx.mockResolvedValue(answer);

      const result = await verifyRecipient('sam@corp.com');

      expect(result.status).toBe('unknown');
      expect(result.status).not.toBe('invalid');
      expect(result.reasons).toEqual(['dns_error']);
      expect(result.hasMx).toBe(false);
    }
  });

  it('does not cache a non-list answer either', async () => {
    resolveMx.mockResolvedValueOnce(undefined);

    const first = await verifyRecipient('sam@corp.com');
    expect(first.status).toBe('unknown');

    withMx();
    const retried = await verifyRecipient('sam@corp.com');

    expect(retried.status).toBe('ok');
  });

  it('resolves to unknown for an error carrying no code at all', async () => {
    resolveMx.mockRejectedValue(new Error('boom'));

    const result = await verifyRecipient('sam@corp.com');

    expect(result.status).toBe('unknown');
  });
});

describe('verifyRecipient — quality flags', () => {
  it('warns on a role address that sits on a domain with MX', async () => {
    withMx();

    for (const local of ['info', 'noreply', 'support', 'no-reply']) {
      resetMxCache();
      const result = await verifyRecipient(`${local}@corp.com`);

      // Deliverable, so not invalid — just a poor thing to cold-email.
      expect(result).toEqual({ status: 'warn', reasons: ['role_address'], hasMx: true });
    }
  });

  it('ignores a plus tag when matching a role address', async () => {
    withMx();

    const result = await verifyRecipient('info+2026@corp.com');

    expect(result.reasons).toEqual(['role_address']);
  });

  it('leaves an ordinary local part alone', async () => {
    withMx();

    const result = await verifyRecipient('information.officer@corp.com');

    expect(result.status).toBe('ok');
    expect(result.reasons).toEqual([]);
  });

  it('warns on a disposable domain', async () => {
    withMx();

    const result = await verifyRecipient('sam@mailinator.com');

    expect(result).toEqual({ status: 'warn', reasons: ['disposable_domain'], hasMx: true });
  });

  it('reports both codes when an address is a role account on a disposable domain', async () => {
    withMx();

    const result = await verifyRecipient('info@mailinator.com');

    expect(result.status).toBe('warn');
    expect(result.reasons).toContain('role_address');
    expect(result.reasons).toContain('disposable_domain');
    expect(result.reasons).toHaveLength(2);
  });

  it('keeps the role and disposable lists non-empty and extendable', () => {
    expect(ROLE_LOCAL_PARTS.has('info')).toBe(true);
    expect(ROLE_LOCAL_PARTS.has('postmaster')).toBe(true);
    expect(DISPOSABLE_DOMAINS.has('mailinator.com')).toBe(true);
    expect(DISPOSABLE_DOMAINS.has('yopmail.com')).toBe(true);
  });
});

/**
 * The cache is keyed by DOMAIN and never by address — both because two addresses
 * on one domain genuinely share an answer, and because a cache keyed by address
 * would be a list of who the user has been contacting, held in memory.
 */
describe('verifyRecipient — the MX cache', () => {
  it('does not re-query DNS for a domain it has already resolved', async () => {
    withMx();

    await verifyRecipient('sam@corp.com');
    await verifyRecipient('sam@corp.com');

    expect(resolveMx).toHaveBeenCalledTimes(1);
  });

  it('queries again for a different domain', async () => {
    withMx();

    await verifyRecipient('sam@corp.com');
    await verifyRecipient('sam@other.com');

    expect(resolveMx).toHaveBeenCalledTimes(2);
    expect(resolveMx).toHaveBeenNthCalledWith(1, 'corp.com');
    expect(resolveMx).toHaveBeenNthCalledWith(2, 'other.com');
  });

  it('shares one entry between two different addresses on the same domain', async () => {
    withMx();

    const first = await verifyRecipient('sam@corp.com');
    const second = await verifyRecipient('jo@corp.com');

    expect(resolveMx).toHaveBeenCalledTimes(1);
    expect(first.status).toBe('ok');
    expect(second.status).toBe('ok');
  });

  it('still applies per-address flags on a cache hit', async () => {
    withMx();

    await verifyRecipient('sam@corp.com');
    const role = await verifyRecipient('info@corp.com');

    expect(resolveMx).toHaveBeenCalledTimes(1);
    expect(role).toEqual({ status: 'warn', reasons: ['role_address'], hasMx: true });
  });

  it('caches a no_mx answer too', async () => {
    resolveMx.mockRejectedValue(dnsError('ENOTFOUND'));

    await verifyRecipient('sam@corp.com');
    const second = await verifyRecipient('jo@corp.com');

    expect(resolveMx).toHaveBeenCalledTimes(1);
    expect(second.status).toBe('invalid');
  });

  it('re-queries after the cache is reset', async () => {
    withMx();

    await verifyRecipient('sam@corp.com');
    resetMxCache();
    await verifyRecipient('sam@corp.com');

    expect(resolveMx).toHaveBeenCalledTimes(2);
  });
});

describe('verifyRecipient — the result shape', () => {
  it('returns stable machine codes, never prose', async () => {
    const scenarios = [
      async () => verifyRecipient('nope'),
      async () => {
        withMx();
        return verifyRecipient('info@mailinator.com');
      },
      async () => {
        resolveMx.mockRejectedValue(dnsError('ENOTFOUND'));
        return verifyRecipient('sam@corp.com');
      },
      async () => {
        resolveMx.mockRejectedValue(dnsError('ESERVFAIL'));
        return verifyRecipient('sam@corp.com');
      }
    ];

    for (const scenario of scenarios) {
      resolveMx.mockReset();
      resetMxCache();

      const result = await scenario();

      expect(['ok', 'warn', 'invalid', 'unknown']).toContain(result.status);
      expect(typeof result.hasMx).toBe('boolean');
      expect(Array.isArray(result.reasons)).toBe(true);
      for (const reason of result.reasons) {
        expect(reason).toMatch(/^[a-z_]+$/);
        expect(reason).not.toMatch(/\s/);
        expect(KNOWN_REASONS.has(reason)).toBe(true);
      }
    }
  });
});
