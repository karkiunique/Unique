import { useMemo, useState } from 'react';

import Icon from '../components/Icon.jsx';
import { LeadColumnMap, LeadPreviewTable } from '../components/LeadColumnMap.jsx';
import LeadUploadSummary from '../components/LeadUploadSummary.jsx';
import { api } from '../lib/api.js';
import { decodeCsvFile, guessMapping, parseCsv, partitionRows, toRows } from '../lib/csv.js';

/**
 * Add recipients to a campaign from a CSV.
 *
 * Pick a file, check the columns it guessed, look at the first ten rows as they
 * will actually be stored, upload. A well-formed file needs no interaction at
 * all — the mapping arrives pre-filled and only a missing email column stops the
 * upload.
 *
 * The file is read in the browser and never uploaded as a file: only the six
 * mapped columns are posted, so the other 40 a CRM export carries never leave
 * this machine. Nothing here logs, and no row content goes into an error message.
 */

/** Enough parse complaints to see the shape of the problem, not the whole file. */
const LISTED_ISSUES = 10;

/**
 * Rows per request. app.js holds a 1MB JSON body limit as a deliberate security
 * control, so a long list is sent in batches rather than the limit raised.
 */
const BATCH_SIZE = 200;

function chunk(rows, size) {
  const batches = [];

  for (let start = 0; start < rows.length; start += size) {
    batches.push(rows.slice(start, start + size));
  }

  return batches;
}

/** Fold one batch's response into the running totals, re-basing its row indices. */
function collect(totals, payload, offset) {
  totals.inserted += Number(payload?.inserted) || 0;

  for (const key of ['skipped', 'rejected', 'flagged']) {
    const entries = Array.isArray(payload?.[key]) ? payload[key] : [];
    totals[key].push(
      ...entries.map((entry) => ({ ...entry, index: (Number(entry?.index) || 0) + offset }))
    );
  }
}

export default function CampaignLeadsPage({ campaignId, onAdded }) {
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState(null);
  const [mapping, setMapping] = useState({});
  const [readError, setReadError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [uploadError, setUploadError] = useState(null);

  const mappedRows = useMemo(() => toRows(parsed?.rows ?? [], mapping), [parsed, mapping]);
  const { ready, missingEmail } = useMemo(() => partitionRows(mappedRows), [mappedRows]);

  async function handleFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    setResult(null);
    setUploadError(null);
    setReadError(null);
    setProgress(null);
    setFileName(file.name);

    try {
      const text = decodeCsvFile(await file.arrayBuffer());
      const next = parseCsv(text);

      setParsed(next);
      setMapping(guessMapping(next.headers));
    } catch {
      // The error is dropped rather than shown: a parser message can quote the
      // line it choked on, and that line is somebody's name and address.
      setParsed(null);
      setMapping({});
      setReadError('That file could not be read as a CSV.');
    }
  }

  function remap(field, header) {
    setMapping((current) => ({ ...current, [field]: header }));
  }

  async function upload() {
    setUploading(true);
    setUploadError(null);
    setResult(null);
    setProgress({ done: 0, total: ready.length });

    const totals = { inserted: 0, skipped: [], rejected: [], flagged: [] };
    let offset = 0;

    try {
      for (const batch of chunk(ready, BATCH_SIZE)) {
        const payload = await api.post(`/campaigns/${encodeURIComponent(campaignId)}/leads`, {
          rows: batch
        });

        collect(totals, payload, offset);
        offset += batch.length;
        setProgress({ done: offset, total: ready.length });
      }

      setResult(totals);
      if (typeof onAdded === 'function') onAdded();
    } catch (err) {
      setUploadError(err.message);
      // Whatever landed before the failure still counts. Saying so beats
      // pretending the upload did nothing and inviting a duplicate run.
      if (totals.inserted > 0) setResult(totals);
    }

    setUploading(false);
  }

  const emailMapped = typeof mapping.email === 'string' && mapping.email !== '';
  const canUpload = emailMapped && ready.length > 0 && !uploading;
  const countsLine = parsed
    ? `${fileName} · ${parsed.rows.length} rows found · ${ready.length} with an email · ${missingEmail.length} without`
    : '';

  return (
    <section className="leadload">
      <div className="kicker red">Add recipients</div>
      <p className="muted lead-note">
        A CSV, read here in your browser. Only the columns you map are sent — the rest never leaves
        this machine.
      </p>

      <div className="rfield">
        <label htmlFor="lead-csv">Recipient list (CSV)</label>
        <input
          id="lead-csv"
          className="rinput lead-file"
          type="file"
          accept=".csv,text/csv"
          onChange={handleFile}
        />
      </div>

      {readError ? (
        <p className="msg error" role="alert">
          {readError}
        </p>
      ) : null}

      {parsed ? (
        <>
          <p className="mono lead-counts">{countsLine}</p>

          {parsed.errors.length > 0 ? (
            <ul className="lead-reasons lead-issues">
              {parsed.errors.slice(0, LISTED_ISSUES).map((issue, position) => (
                <li key={`${issue.code}-${issue.row}-${position}`}>
                  {issue.row === null ? issue.message : `Row ${issue.row + 1}: ${issue.message}`}
                </li>
              ))}
            </ul>
          ) : null}

          <LeadColumnMap headers={parsed.headers} mapping={mapping} onChange={remap} />

          {emailMapped ? null : (
            <p className="msg error" role="alert">
              No email column is mapped. Point Email at the column holding the address — nothing else
              is required.
            </p>
          )}

          <LeadPreviewTable rows={mappedRows} />

          <button type="button" className="btn red" onClick={upload} disabled={!canUpload}>
            <Icon name={uploading ? 'loader' : 'plus'} />
            {uploading
              ? 'Adding…'
              : `Add ${ready.length} ${ready.length === 1 ? 'recipient' : 'recipients'}`}
          </button>

          {uploading && progress ? (
            <p className="mono lead-progress" role="status">
              {`Adding ${progress.done} of ${progress.total}…`}
            </p>
          ) : null}
        </>
      ) : null}

      {uploadError ? (
        <p className="msg error" role="alert">
          {uploadError}
        </p>
      ) : null}

      {result ? <LeadUploadSummary result={result} /> : null}
    </section>
  );
}
