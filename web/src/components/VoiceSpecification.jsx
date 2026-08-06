import { Fragment } from 'react';

import { lengthRange, listValue, numberValue, profileJsonOf, textValue } from '../lib/profileJson.js';

/**
 * The right-hand "Specification" column of the voice dossier: the mechanical
 * read-out — formality, length, and one ledger row per trait.
 *
 * Every value goes through the defensive readers in lib/profileJson.js, and a
 * row with nothing to say is omitted rather than rendered blank.
 */

const FORMALITY_TICKS = 10;

// The traits, in reading order. Emoji sits with the other mechanical habits.
const TRAITS = [
  ['Tone', 'tone'],
  ['Sentence rhythm', 'sentence_rhythm'],
  ['Paragraphs', 'paragraph_style'],
  ['Contractions', 'contractions'],
  ['Punctuation', 'punctuation_habits'],
  ['Capitalisation', 'capitalization_quirks'],
  ['Vocabulary', 'vocabulary_level'],
  ['Emoji', 'emoji_usage'],
  ['Humour', 'humor'],
  ['How you ask', 'how_they_ask']
];

/** A word for the number, so the meter reads as something and not just a score. */
function formalityWord(value) {
  if (value <= 4) return 'casual';
  return value <= 7 ? 'conversational' : 'formal';
}

function FormalityMeter({ value }) {
  return (
    <div className="spec-meter">
      <div className="rowline spec-row">
        <span className="kicker">Formality</span>
        <span className="mono spec-value">
          {value}/10 · {formalityWord(value)}
        </span>
      </div>
      <div className="rowline meter">
        {Array.from({ length: FORMALITY_TICKS }, (_, index) => (
          <span key={index} className={index < value ? 'meter-tick on' : 'meter-tick'} />
        ))}
      </div>
    </div>
  );
}

/** "v2 · 42 emails", dropping whichever half the row does not have. */
function specMeta(profile) {
  const version = textValue(profile?.version);
  const count = textValue(profile?.source_email_count);
  const parts = [];

  if (version) parts.push(`v${version}`);
  if (count) parts.push(`${count} emails`);

  return parts.length > 0 ? parts.join(' · ') : 'built from your sent mail';
}

export default function VoiceSpecification({ profile }) {
  const json = profileJsonOf(profile);

  const formality = numberValue(json.formality_1to10);
  const length = lengthRange(json.typical_length_words);
  const corrections = listValue(json.learned_corrections);

  const traits = TRAITS.map(([label, key]) => [label, textValue(json[key])]).filter(
    ([, value]) => value !== null
  );

  return (
    <div className="block plain pop spec">
      <div className="spec-head">
        <div className="rowline spec-row">
          <span className="kicker">Specification</span>
          <span className="mono spec-meta">{specMeta(profile)}</span>
        </div>

        {formality !== null ? <FormalityMeter value={formality} /> : null}

        {length ? (
          <div className="rowline spec-row spec-length">
            <span className="kicker">Length</span>
            <span className="mono spec-value">{length}</span>
          </div>
        ) : null}
      </div>

      <div className="ledger spec-ledger">
        {traits.map(([label, value]) => (
          <Fragment key={label}>
            <div className="k">{label}</div>
            <div className="v">{value}</div>
          </Fragment>
        ))}
        {corrections.length > 0 ? (
          <Fragment key="learned">
            <div className="k">Learned from your edits</div>
            <div className="v">{corrections.join(' · ')}</div>
          </Fragment>
        ) : null}
      </div>
    </div>
  );
}
