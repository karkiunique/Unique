import { Fragment } from 'react';

/**
 * Read-only render of a voice_profiles row.
 *
 * `profile_json` comes back from the model, so every field here is treated as
 * possibly missing or the wrong type — a malformed profile must degrade to a
 * shorter summary, never to a crash.
 */

const TEXT_FIELDS = [
  ['Tone', 'tone'],
  ['Sentence rhythm', 'sentence_rhythm'],
  ['Paragraph style', 'paragraph_style'],
  ['Contractions', 'contractions'],
  ['Punctuation habits', 'punctuation_habits'],
  ['Capitalization quirks', 'capitalization_quirks'],
  ['Vocabulary', 'vocabulary_level'],
  ['Emoji usage', 'emoji_usage'],
  ['Humor', 'humor'],
  ['How they ask', 'how_they_ask']
];

const LIST_FIELDS = [
  ['Greetings they actually use', 'greeting_styles'],
  ['Sign-offs', 'signoff_styles'],
  ['Sentence starters', 'sentence_starters'],
  ['Transition words', 'transition_words'],
  ['Signature phrases', 'signature_phrases']
];

function textValue(value) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function listValue(value) {
  if (!Array.isArray(value)) return [];
  return value.map(textValue).filter((entry) => entry !== null);
}

function lengthValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parts = ['min', 'median', 'max']
    .map((key) => (typeof value[key] === 'number' && Number.isFinite(value[key]) ? `${key} ${value[key]}` : null))
    .filter((part) => part !== null);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function Chips({ title, items }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h2>{title}</h2>
      <ul className="chips">
        {items.map((item, index) => (
          <li key={`${item}-${index}`} className="chip">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function VoiceProfileSummary({ profile }) {
  const json =
    profile?.profile_json && typeof profile.profile_json === 'object' && !Array.isArray(profile.profile_json)
      ? profile.profile_json
      : {};

  const formality = textValue(json.formality_1to10);
  const lengths = lengthValue(json.typical_length_words);
  const neverDoes = listValue(json.never_does);
  const corrections = listValue(json.learned_corrections);

  const facts = TEXT_FIELDS.map(([label, key]) => [label, textValue(json[key])]).filter(
    ([, value]) => value !== null
  );

  const sourceCount = textValue(profile?.source_email_count);
  const version = textValue(profile?.version);

  return (
    <section className="profile">
      <p className="muted">
        {sourceCount ? `Built from ${sourceCount} sent emails` : 'Built from your sent mail'}
        {version ? ` · version ${version}` : ''}
      </p>

      <dl className="facts">
        {formality ? (
          <>
            <dt>Formality</dt>
            <dd>{formality} / 10</dd>
          </>
        ) : null}
        {lengths ? (
          <>
            <dt>Typical length (words)</dt>
            <dd>{lengths}</dd>
          </>
        ) : null}
        {facts.map(([label, value]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>

      {LIST_FIELDS.map(([label, key]) => (
        <Chips key={key} title={label} items={listValue(json[key])} />
      ))}

      {neverDoes.length > 0 ? (
        <div className="never-does">
          <h2>Never does</h2>
          <p className="muted">
            The anti-AI-slop filter — every generated email is checked against this list.
          </p>
          <ul className="chips">
            {neverDoes.map((item, index) => (
              <li key={`${item}-${index}`} className="chip danger">
                {item}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Chips title="Learned from your edits" items={corrections} />
    </section>
  );
}
