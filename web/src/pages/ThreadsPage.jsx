import { useCallback, useEffect, useRef, useState } from 'react';

import Icon from '../components/Icon.jsx';
import RegisterRow from '../components/RegisterRow.jsx';
import ThreadDetail from '../components/ThreadDetail.jsx';
import { PageHead } from '../components/Shell.jsx';
import { api } from '../lib/api.js';

/**
 * Section III — the register: every letter sent FROM UNIQUE, and who wrote back.
 * Explicitly NOT an inbox: the server lists only the threads recorded in this
 * user's send_log, and persists nothing it reads back out of Gmail.
 *
 * Refreshing is the user's decision. The background timer below exists only so a
 * reply that arrives while the page sits open eventually shows up, and it stands
 * down entirely while a thread is open or the search box is in use — a list that
 * reorders itself under someone's eyes or hands is worse than a stale one.
 *
 * The search term is recipient data: it is sent to the server to filter on and is
 * never logged, stored, or put in the page URL (CLAUDE.md § Privacy).
 */

const POLL_MS = 30000;
const SEARCH_DEBOUNCE_MS = 300;

/** The register endpoint — no `q` at all when the box is empty. */
function registerPath(query) {
  return query === '' ? '/threads' : `/threads?q=${encodeURIComponent(query)}`;
}

function clockLabel(at) {
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export default function ThreadsPage() {
  const [threads, setThreads] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [search, setSearch] = useState('');
  const [searchPending, setSearchPending] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [openThreadId, setOpenThreadId] = useState(null);
  // The query the currently displayed list was fetched for. Empty means unfiltered,
  // which is what tells "no matches" apart from "nothing sent yet".
  const [listedQuery, setListedQuery] = useState('');

  const mounted = useRef(true);
  // Monotonic request id. A response that is not the newest is dropped, so a slow
  // early search can never land on top of a newer one.
  const latestRequest = useRef(0);
  const firstLoad = useRef(true);
  const pausedRef = useRef(false);
  const queryRef = useRef('');

  const query = search.trim();

  const load = useCallback((forQuery) => {
    const request = latestRequest.current + 1;
    latestRequest.current = request;

    api
      .get(registerPath(forQuery))
      .then((payload) => {
        if (!mounted.current || request !== latestRequest.current) return;
        setThreads(Array.isArray(payload?.threads) ? payload.threads : []);
        setListedQuery(forQuery);
        setError(null);
        setLoaded(true);
        setUpdatedAt(Date.now());
      })
      .catch((err) => {
        if (!mounted.current || request !== latestRequest.current) return;
        setError(err.message);
        setListedQuery(forQuery);
        setLoaded(true);
      });
  }, []);

  useEffect(() => {
    mounted.current = true;

    return () => {
      // Nothing may set state after this point, timer or in-flight request alike.
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    queryRef.current = query;

    // The first paint should not sit blank for the debounce: there is no query yet.
    if (firstLoad.current) {
      firstLoad.current = false;
      load(query);
      return undefined;
    }

    setSearchPending(true);
    const timer = setTimeout(() => {
      setSearchPending(false);
      load(query);
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, load]);

  const paused = openThreadId !== null || searchFocused || searchPending;

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    const timer = setInterval(() => {
      // Reading a thread or typing a search is never interrupted. The explicit
      // Refresh control is the way to pull new state on purpose.
      if (pausedRef.current) return;
      load(queryRef.current);
    }, POLL_MS);

    return () => clearInterval(timer);
  }, [load]);

  if (openThreadId !== null) {
    return (
      <ThreadDetail
        key={openThreadId}
        threadId={openThreadId}
        onBack={() => setOpenThreadId(null)}
      />
    );
  }

  const replied = threads.filter((thread) => thread?.replied).length;
  const searched = listedQuery !== '';

  return (
    <>
      <PageHead
        kicker="Section III"
        title={
          <>
            The <em>register</em>.
          </>
        }
        sub="Every letter you've sent from this desk, and who has written back."
        aside={
          <div className="block--red pop replies-tally">
            <div className="kicker">Replies</div>
            <div className="serif tally">
              {replied}
              <span className="of">/{threads.length}</span>
            </div>
          </div>
        }
      />

      <div className="reg-toolbar">
        <div className="rfield reg-search">
          <label htmlFor="reg-search">Search subject or recipient</label>
          <input
            id="reg-search"
            className="rinput"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            placeholder="a word from the subject, or an address"
          />
        </div>

        <div className="reg-controls">
          <button type="button" className="btn plain" onClick={() => load(query)}>
            <Icon name="rotate-cw" />
            Refresh
          </button>
          <span className="mono faint reg-updated">
            {updatedAt === null ? 'Not loaded yet' : `Updated ${clockLabel(updatedAt)}`}
          </span>
        </div>
      </div>

      {error ? (
        <p className="msg error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="register">
        <div className="reg-head">
          <span className="reg-no">No.</span>
          <span className="reg-subject">Subject &amp; recipient</span>
          <span className="reg-sent">Sent</span>
          <span className="reg-status">Status</span>
        </div>

        {threads.map((thread, position) => (
          <RegisterRow
            key={thread?.threadId ?? position}
            thread={thread}
            position={position}
            onOpen={setOpenThreadId}
          />
        ))}

        {/* Two different situations, two different sentences: an empty desk is not
            the same news as a search that found nothing. */}
        {loaded && !error && threads.length === 0 ? (
          <p className="muted reg-empty">
            {searched ? 'No letter matches that search.' : 'Nothing sent from here yet.'}
          </p>
        ) : null}
      </div>

      <p className="tick reg-note">
        <Icon name="lock" />
        Not an inbox — only the letters you sent from here are listed, nothing else in your mailbox
        is read, and none of it is stored.
      </p>
    </>
  );
}
