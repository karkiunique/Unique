import VoiceSpecification from './VoiceSpecification.jsx';
import { listValue, profileJsonOf, textValue } from '../lib/profileJson.js';

/**
 * The voice dossier: a printed style guide built from the user's own sent mail.
 *
 * Left column is the verbatim evidence — the way they ask, the greetings and
 * phrases they actually use, and the things they never do. Right column is the
 * mechanical specification. Everything is read defensively (lib/profileJson.js):
 * a field that is missing or the wrong type is omitted, never fatal.
 */

// Every verbatim list on the left, in the order they read best. `plain` sets the
// quieter rule-coloured underline; the red one is reserved for greetings/sign-offs.
const CLIPPING_SETS = [
  ['Greetings you use', 'greeting_styles', false],
  ['How you sign off', 'signoff_styles', false],
  ['Phrases that are yours', 'signature_phrases', true],
  ['Sentence starters', 'sentence_starters', true],
  ['Transition words', 'transition_words', true]
];

/**
 * how_they_ask is prose with a verbatim example after a dash. Quote the example
 * when there is one, otherwise quote the whole thing.
 */
function pullQuote(howTheyAsk) {
  if (howTheyAsk === null) return null;

  const dash = howTheyAsk.search(/[—–]/);
  const tail = dash === -1 ? '' : howTheyAsk.slice(dash + 1).trim();
  const quoted = (tail === '' ? howTheyAsk : tail).replace(/^["'“”]+|["'“”.]+$/g, '').trim();

  return quoted === '' ? null : quoted;
}

function Clippings({ title, items, plain }) {
  if (items.length === 0) return null;

  return (
    <div className="clipping-set">
      <div className="kicker">{title}</div>
      <div className="clips">
        {items.map((item, index) => (
          <span key={`${item}-${index}`} className={plain ? 'clip plain' : 'clip'}>
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function VoiceProfileSummary({ profile }) {
  const json = profileJsonOf(profile);

  const quote = pullQuote(textValue(json.how_they_ask));
  const neverDoes = listValue(json.never_does);

  return (
    <div className="dossier">
      <div className="stack dossier-left">
        {quote ? (
          <blockquote className="block--ink pop pullquote">
            <div className="kicker">In your own words</div>
            <p>“{quote}”</p>
            <div className="mono attribution">— how you actually make an ask</div>
          </blockquote>
        ) : null}

        {CLIPPING_SETS.map(([title, key, plain]) => (
          <Clippings key={key} title={title} items={listValue(json[key])} plain={plain} />
        ))}

        {neverDoes.length > 0 ? (
          <div className="wash-red struck">
            <div className="kicker red">Struck from every draft — your anti-slop filter</div>
            <div className="clips">
              {neverDoes.map((item, index) => (
                <span key={`${item}-${index}`} className="strike">
                  {item}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <VoiceSpecification profile={profile} />
    </div>
  );
}
