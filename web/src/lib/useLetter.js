import { useEffect, useState } from 'react';

import { api } from './api.js';
import { letterOf } from './letter.js';

/**
 * One recipient's letter: fetched on its own, edited, approved, redrafted.
 *
 * The review deck runs on this hook, so the web app contains exactly ONE
 * approval call. Keep it that way if a second reviewer is ever added: a forked
 * copy is how a screen ends up approving a letter nobody read, or approving
 * words other than the ones on screen.
 *
 * A letter is fetched only when somebody is actually about to read it, and every
 * field is re-read from what the server stored after a write rather than from
 * what the browser hoped it stored. Nothing here logs: the body is email content.
 */

const NOT_FOUND = 404;

export function useLetter(leadId, onChanged) {
  const [lead, setLead] = useState(null);
  // 'loading' | 'ready' | 'missing' | 'error'
  const [state, setState] = useState('loading');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  // Unsaved changes. The approval that follows carries them in the same request.
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const letterPath = `/leads/${encodeURIComponent(leadId)}`;

  function applyLead(next) {
    const letter = letterOf(next);

    setLead(next);
    setSubject(letter.subject);
    setBody(letter.body);
    setDirty(false);
  }

  useEffect(() => {
    // A deck opened on an empty roll has no letter to ask for, and asking anyway
    // would be a request for a row that isn't the caller's.
    if (typeof leadId !== 'string' || leadId === '') {
      setState('missing');
      return undefined;
    }

    let active = true;

    setState('loading');
    api
      .get(`/leads/${encodeURIComponent(leadId)}`)
      .then((payload) => {
        if (!active) return;
        applyLead(payload?.lead ?? null);
        setError(null);
        setState('ready');
      })
      .catch((err) => {
        if (!active) return;
        setState(err?.status === NOT_FOUND ? 'missing' : 'error');
        if (err?.status !== NOT_FOUND) setError(err.message);
      });

    return () => {
      active = false;
    };
  }, [leadId]);

  /**
   * One PATCH or POST, then re-read every field from what the server stored.
   * Resolves true when the server accepted it — the deck advances on that, never
   * on the assumption that a request sent is a request stored.
   */
  async function submit(request) {
    setBusy(true);
    setError(null);

    try {
      const payload = await request();

      // Only ever from what the server stored — never from what we hoped it did.
      if (payload?.lead) applyLead(payload.lead);
      if (typeof onChanged === 'function') onChanged();

      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function editSubject(value) {
    setSubject(value);
    setDirty(true);
  }

  function editBody(value) {
    setBody(value);
    setDirty(true);
  }

  function saveEdits() {
    return submit(() => api.patch(letterPath, { subject, body }));
  }

  /**
   * Unsaved words are approved in the same request that approves them, so the
   * letter on screen and the letter approved are never two different letters.
   */
  function approve() {
    const patch = dirty ? { subject, body, approve: true } : { approve: true };

    return submit(() => api.patch(letterPath, patch));
  }

  function redraft() {
    return submit(() => api.post(`${letterPath}/regenerate`, {}));
  }

  return {
    lead,
    state,
    subject,
    body,
    dirty,
    busy,
    error,
    editSubject,
    editBody,
    saveEdits,
    approve,
    redraft
  };
}
