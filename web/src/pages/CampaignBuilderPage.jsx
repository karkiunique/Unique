import { useEffect, useState } from 'react';

import Icon from '../components/Icon.jsx';
import { PageHead } from '../components/Shell.jsx';
import { api } from '../lib/api.js';
import { navigateTo } from '../lib/navigate.js';
import { useAutoGrow } from '../lib/useAutoGrow.js';

/**
 * Section IV — set up a campaign.
 *
 * Two ways to write it. In VOICE mode the whole letter is drafted from the voice
 * profile. In TEMPLATE mode the user writes the letter and marks the parts that
 * should be written per recipient with {{personalized}}.
 *
 * A template with no {{personalized}} section is a mail merge — the same letter
 * to everyone bar their first name — so submit is blocked without one. The
 * server enforces the same rule and stays the authority; this is only the early,
 * kinder version of that 400.
 */

const PERSONALIZED = '{{personalized}}';
const MERGE_VARS = ['{{first_name}}', '{{company}}', '{{title}}', PERSONALIZED];

const MODES = [
  {
    value: 'voice',
    label: 'Voice',
    icon: 'feather',
    note: 'Each letter is written from scratch in your voice, for that one recipient.'
  },
  {
    value: 'template',
    label: 'Template',
    icon: 'pen-line',
    note: 'You write the letter. Only the {{personalized}} sections are written per recipient.'
  }
];

export default function CampaignBuilderPage() {
  const [name, setName] = useState('');
  const [mode, setMode] = useState('voice');
  const [subject, setSubject] = useState('');
  const [templateBody, setTemplateBody] = useState('');
  // Where the caret should land after a merge var is inserted. React owns the
  // value, so the DOM node has not caught up at the moment of the click.
  const [caret, setCaret] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const templateRef = useAutoGrow(templateBody);

  useEffect(() => {
    if (caret === null) return;

    const field = templateRef.current;
    if (field) {
      field.focus();
      field.setSelectionRange(caret, caret);
    }
    setCaret(null);
  }, [caret, templateRef]);

  /** Insert at the cursor, replacing whatever is selected — never append blindly. */
  function insertMergeVar(token) {
    const field = templateRef.current;
    const start = field?.selectionStart ?? templateBody.length;
    const end = field?.selectionEnd ?? start;

    setTemplateBody(`${templateBody.slice(0, start)}${token}${templateBody.slice(end)}`);
    setCaret(start + token.length);
  }

  async function submit() {
    setError(null);
    setBusy(true);

    const payload = { name: name.trim(), mode, subject_template: subject.trim() };
    // Voice mode sends no template at all, rather than an empty one.
    if (mode === 'template') payload.template_body = templateBody;

    try {
      const created = await api.post('/campaigns', payload);
      const campaignId = created?.campaign?.id;

      navigateTo(campaignId ? `/campaigns/${campaignId}` : '/campaigns');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const isTemplate = mode === 'template';
  const missingMarker = isTemplate && !templateBody.includes(PERSONALIZED);
  const canSubmit =
    name.trim() !== '' && !busy && (!isTemplate || (templateBody.trim() !== '' && !missingMarker));
  const modeNote = MODES.find((option) => option.value === mode)?.note ?? '';

  return (
    <>
      <button type="button" className="linkbtn thread-back" onClick={() => navigateTo('/campaigns')}>
        <Icon name="arrow-left" />
        Back to the roll
      </button>

      <PageHead
        kicker="Section IV · New campaign"
        title={
          <>
            Set the <em>run</em>.
          </>
        }
        sub="Name it, choose how it is written, and it lands in your roll as a draft."
      />

      <div className="builder">
        <div>
          <div className="kicker red">The setup</div>

          <div className="rfield">
            <label htmlFor="campaign-name">Campaign name</label>
            <input
              id="campaign-name"
              className="rinput"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Series A founders, August"
            />
          </div>

          <div className="rfield">
            <span className="mode-label">How it is written</span>
            <div className="rowline mode-toggle" role="group" aria-label="How it is written">
              {MODES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={mode === option.value ? 'btn mode-option' : 'btn plain mode-option'}
                  aria-pressed={mode === option.value}
                  onClick={() => setMode(option.value)}
                >
                  <Icon name={option.icon} />
                  {option.label}
                </button>
              ))}
            </div>
            <p className="muted mode-note">{modeNote}</p>
          </div>

          <div className="rfield">
            <label htmlFor="campaign-subject">Subject line</label>
            <input
              id="campaign-subject"
              className="rinput"
              type="text"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder="a question about {{company}}"
            />
          </div>

          <button type="button" className="btn red block" onClick={submit} disabled={!canSubmit}>
            <Icon name={busy ? 'loader' : 'plus'} />
            {busy ? 'Setting it up…' : 'Create campaign'}
          </button>

          {error ? (
            <p className="msg error" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <div>
          <div className="rowline letter-head">
            <div className="kicker">{isTemplate ? 'The template' : 'The letter'}</div>
            {isTemplate ? (
              <span className={missingMarker ? 'tag red' : 'tag'}>
                <Icon name={missingMarker ? 'triangle-alert' : 'check'} />
                {missingMarker ? '{{personalized}} required' : 'personalised'}
              </span>
            ) : null}
          </div>

          {isTemplate ? (
            <>
              <div className="mergebar">
                {MERGE_VARS.map((token) => (
                  <button
                    key={token}
                    type="button"
                    className={token === PERSONALIZED ? 'mergevar required' : 'mergevar'}
                    onClick={() => insertMergeVar(token)}
                  >
                    {token}
                  </button>
                ))}
              </div>

              <textarea
                ref={templateRef}
                className="rtext template-input"
                rows={12}
                aria-label="Letter template"
                value={templateBody}
                onChange={(event) => setTemplateBody(event.target.value)}
                placeholder={`Hi {{first_name}},\n\n${PERSONALIZED}\n\nworth 15 minutes next week?`}
              />

              {/* The tag above states the requirement from the start; this fuller
                  telling-off waits until there is actually a template to fix. */}
              {missingMarker && templateBody.trim() !== '' ? (
                <div className="gate">
                  <p className="msg error gate-msg" role="alert">
                    A template needs at least one {PERSONALIZED} section
                  </p>
                  <p className="gate-note">
                    Without one, every recipient gets the same letter bar their first name. Put the
                    marker where the sentence about them should go.
                  </p>
                </div>
              ) : null}
            </>
          ) : (
            <div className="block plain voice-note">
              <p className="lead">
                Nothing to write here. Each letter is drafted from your voice profile against what is
                known about the recipient, then shown to you before anything is sent.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
