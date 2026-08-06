import { useRef, useState } from 'react';

import { api } from './api.js';

/**
 * The deliverability check behind the To field.
 *
 * Advisory by construction: it exposes a verdict and nothing else — no error
 * state, no "blocked" flag, nothing a caller could hang a disabled button on. A
 * DNS hiccup must never stand between the user and a legitimate send, and the
 * user may know something we do not.
 *
 * Runs on blur, not per keystroke: a half-typed address is not a domain, and
 * every call costs a DNS lookup on the server.
 */
export function useRecipientCheck() {
  const [verification, setVerification] = useState(null);
  const [checking, setChecking] = useState(false);
  // The address the current verdict belongs to. Kept so an unchanged address is
  // not re-checked on every blur.
  const checkedAddress = useRef('');

  async function check(value) {
    const address = typeof value === 'string' ? value.trim() : '';
    if (address === '' || address === checkedAddress.current) return;

    checkedAddress.current = address;
    setVerification(null);
    setChecking(true);

    let verdict;
    try {
      const payload = await api.post('/send/verify-recipient', { to: address });
      verdict = {
        status: typeof payload?.status === 'string' ? payload.status : 'unknown',
        reasons: Array.isArray(payload?.reasons) ? payload.reasons : []
      };
    } catch {
      // A check that failed is "we do not know", never "this address is bad".
      verdict = { status: 'unknown', reasons: [] };
    }

    // A newer address was checked while this was in flight; that answer wins.
    if (checkedAddress.current !== address) return;

    setVerification(verdict);
    setChecking(false);
  }

  /** Drop a verdict as soon as it stops being about what is in the field. */
  function forget(value) {
    const address = typeof value === 'string' ? value.trim() : '';
    if (address === checkedAddress.current) return;

    setVerification(null);
    setChecking(false);
  }

  function reset() {
    checkedAddress.current = '';
    setVerification(null);
    setChecking(false);
  }

  return { verification, checking, check, forget, reset };
}
