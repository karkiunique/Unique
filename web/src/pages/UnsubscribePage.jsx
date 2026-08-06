import { useEffect, useState } from 'react';

import Icon from '../components/Icon.jsx';
import { api } from '../lib/api.js';

/**
 * The public unsubscribe page — `{APP_URL}/u/{token}`.
 *
 * The person reading this is not a user and never will be: no masthead, no
 * nav, no sign-in prompt, no account. It is a deliverability surface, so it
 * has to look deliberate and say plainly what happened.
 *
 * Failures are shown as one calm state. The server deliberately does not say
 * why a token failed (that reason is an oracle for probing), and nothing about
 * the request is echoed back onto the page.
 */

const PATH_PREFIX = '/u/';

/** The token carried by `/u/<token>`, or null when this is not that route. */
export function unsubscribeTokenFromPath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(PATH_PREFIX)) return null;

  const raw = pathname.slice(PATH_PREFIX.length).split('/')[0].trim();
  if (raw === '') return null;

  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function currentPathname() {
  try {
    return window.location.pathname || '/';
  } catch {
    return '/';
  }
}

const VIEWS = {
  working: {
    heading: 'One moment.',
    lead: 'Recording your request.',
    note: 'Nothing else about you is being looked up.'
  },
  unsubscribed: {
    stamp: { label: 'Removed.', tone: 'green', icon: 'check' },
    heading: 'You are off this list.',
    lead: 'Your address has been removed. You will not be contacted again from this sender.',
    note: 'No account was created · Nothing else was recorded'
  },
  already: {
    stamp: { label: 'Already removed', tone: 'green', icon: 'check' },
    heading: 'You were already off this list.',
    lead: 'Your address was removed before, so there is nothing left to do. You will not be contacted again from this sender.',
    note: 'No further action is needed'
  },
  invalid: {
    stamp: { label: 'Link not valid', tone: 'ink', icon: 'triangle-alert' },
    heading: 'This link is no longer valid.',
    lead: 'It may have expired, or been altered somewhere on the way here. To be taken off the list, reply to the email directly and say so — that works just as well.',
    note: 'Nothing was changed'
  }
};

export default function UnsubscribePage() {
  const [view, setView] = useState('working');

  useEffect(() => {
    let active = true;
    const token = unsubscribeTokenFromPath(currentPathname());

    if (!token) {
      setView('invalid');
      return undefined;
    }

    api
      .post(`/unsubscribe/${token}`, undefined, { auth: false })
      .then((payload) => {
        if (!active) return;
        setView(payload?.status === 'already' ? 'already' : 'unsubscribed');
      })
      .catch(() => {
        // The reason stays server-side: never render a raw error to a stranger.
        if (active) setView('invalid');
      });

    return () => {
      active = false;
    };
  }, []);

  const copy = VIEWS[view];

  return (
    <main className="unsub">
      <div className="unsub-sheet">
        <div className="wordmark">
          Unique<span className="dot">.</span>
        </div>
        <div className="hr unsub-rule" />

        <div className="unsub-mark">
          {copy.stamp ? (
            <span className={`stamp ${copy.stamp.tone}`}>
              <Icon name={copy.stamp.icon} />
              {copy.stamp.label}
            </span>
          ) : (
            <span className="tick">
              <Icon name="loader" />
              Working
            </span>
          )}
        </div>

        <h1>{copy.heading}</h1>
        <p className="lead">{copy.lead}</p>
        <p className="unsub-note">{copy.note}</p>
      </div>
    </main>
  );
}
