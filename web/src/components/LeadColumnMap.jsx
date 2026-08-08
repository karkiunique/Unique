import { LEAD_FIELDS } from '../lib/csv.js';

/**
 * The two halves of "check this before you upload it": which column feeds which
 * field, and what the first few rows will look like once they have.
 *
 * The preview deliberately shows the MAPPED row rather than the raw CSV line —
 * trimmed, with the unmapped columns gone — because that is what will actually
 * be stored, and a preview that shows something else is worse than none.
 */

const PREVIEW_ROWS = 10;

/** One select per target field, so a badly-named column can be pointed by hand. */
export function LeadColumnMap({ headers, mapping, onChange }) {
  return (
    <div className="lead-map">
      {LEAD_FIELDS.map((field) => (
        <div className="rfield lead-map-field" key={field.key}>
          <label htmlFor={`map-${field.key}`}>
            {field.required ? `${field.label} (required)` : field.label}
          </label>
          <select
            id={`map-${field.key}`}
            className="rinput"
            value={mapping[field.key] ?? ''}
            onChange={(event) => onChange(field.key, event.target.value)}
          >
            <option value="">— not mapped —</option>
            {headers.map((header) => (
              <option key={header} value={header}>
                {header}
              </option>
            ))}
          </select>
        </div>
      ))}
    </div>
  );
}

export function LeadPreviewTable({ rows }) {
  return (
    <table className="lead-preview">
      <thead>
        <tr>
          {LEAD_FIELDS.map((field) => (
            <th key={field.key}>{field.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, PREVIEW_ROWS).map((row, position) => (
          <tr key={position}>
            {LEAD_FIELDS.map((field) => (
              <td key={field.key}>{row[field.key] ?? ''}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
