import { useCallback, useEffect, useState } from 'react';

import Icon from '../components/Icon.jsx';
import ErrorNotice from '../components/ErrorNotice.jsx';
import { api } from '../lib/api.js';

/**
 * The standing target — set once, revisable (CLAUDE.md, Decisions 2026-08-16).
 *
 * The structured fields drive the lead search; the notes go to the model when it
 * judges whether there is anything specific enough to write about.
 *
 * THE CEILING IS PRESENTED AS A CEILING. The copy says "at most", because a user
 * who reads it as a quota will wonder why some days are short, and the honest
 * answer — nothing cleared the bar — is the product working.
 */

const LIST_FIELDS = [
  ['titles', 'Job titles', 'Director of Technology, Head of IT'],
  ['seniority', 'Seniority', 'director, vp, head'],
  ['industries', 'Industries', 'K-12 education, edtech'],
  ['geos', 'Places', 'California, Pacific Northwest'],
  ['exclude_domains', 'Never contact these domains', 'competitor.com, bigclient.org'],
  ['exclude_industries', 'Never these industries', 'gambling, tobacco']
];

/** Comma-separated in the box, array on the wire. */
function toText(value) {
  return Array.isArray(value) ? value.join(', ') : '';
}

function toList(text) {
  return text
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

export default function TargetPage() {
  const [form, setForm] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const payload = await api.get('/target');
      const target = payload?.target ?? {};

      setForm({
        titles: toText(target.titles),
        seniority: toText(target.seniority),
        industries: toText(target.industries),
        geos: toText(target.geos),
        exclude_domains: toText(target.exclude_domains),
        exclude_industries: toText(target.exclude_industries),
        companySize: target.company_size ?? '',
        fitNotes: target.fit_notes ?? '',
        dailyTarget: target.daily_target ?? 2
      });
      setState('ready');
    } catch (err) {
      setError(err?.message || 'Could not load your target.');
      setState('error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    setSaved(false);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await api.put('/target', {
        titles: toList(form.titles),
        seniority: toList(form.seniority),
        industries: toList(form.industries),
        geos: toList(form.geos),
        excludeDomains: toList(form.exclude_domains),
        excludeIndustries: toList(form.exclude_industries),
        companySize: form.companySize,
        fitNotes: form.fitNotes,
        dailyTarget: Number(form.dailyTarget)
      });
      setSaved(true);
    } catch (err) {
      setError(err?.message || 'Could not save your target.');
    } finally {
      setBusy(false);
    }
  }

  if (state === 'loading') {
    return (
      <div className="daily">
        <p className="muted">Fetching your target…</p>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="daily">
        <ErrorNotice message={error} onRetry={load} />
      </div>
    );
  }

  return (
    <div className="daily">
      <div className="kicker red">Your standing target</div>
      <h1>Who should Unique look for?</h1>
      <p className="lead">
        Set this once. Every night Unique hunts against it, researches whoever it finds, and drafts
        a letter in your voice for the ones worth writing to.
      </p>

      <form onSubmit={handleSubmit} className="target-form">
        {LIST_FIELDS.map(([field, label, placeholder]) => (
          <div className="rfield" key={field}>
            <label htmlFor={`target-${field}`}>{label}</label>
            <input
              id={`target-${field}`}
              className="rinput"
              type="text"
              value={form[field]}
              placeholder={placeholder}
              onChange={(event) => update(field, event.target.value)}
            />
          </div>
        ))}

        <div className="rfield">
          <label htmlFor="target-size">Company size</label>
          <input
            id="target-size"
            className="rinput"
            type="text"
            value={form.companySize}
            placeholder="11-50"
            onChange={(event) => update('companySize', event.target.value)}
          />
        </div>

        <div className="rfield">
          <label htmlFor="target-notes">What makes someone a good fit?</label>
          <textarea
            id="target-notes"
            className="rinput"
            rows={4}
            value={form.fitNotes}
            placeholder="In your own words — what you sell, who it helps, what a good conversation looks like."
            onChange={(event) => update('fitNotes', event.target.value)}
          />
          <p className="muted field-hint">
            This is what Unique reads when it decides whether there is anything specific enough to
            write about. The more concrete, the fewer weak leads.
          </p>
        </div>

        <div className="rfield">
          <label htmlFor="target-daily">Letters a day, at most</label>
          <input
            id="target-daily"
            className="rinput target-daily"
            type="number"
            min={1}
            max={5}
            value={form.dailyTarget}
            onChange={(event) => update('dailyTarget', event.target.value)}
          />
          {/* Said plainly, because a user who reads this as a quota will think a
              short day is a bug. A short day is the gates working. */}
          <p className="muted field-hint">
            A ceiling, not a quota. Unique would rather send you one letter worth reading than fill
            the number with people you would only turn down.
          </p>
        </div>

        {error ? (
          <p className="msg error" role="alert">
            {error}
          </p>
        ) : null}
        {saved ? <p className="msg notice">Saved. Tonight&apos;s run will use this.</p> : null}

        <button className="btn red" type="submit" disabled={busy}>
          <Icon name={busy ? 'loader' : 'check'} />
          {busy ? 'Saving…' : 'Save target'}
        </button>
      </form>
    </div>
  );
}
