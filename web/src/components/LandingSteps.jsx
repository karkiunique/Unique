import Icon from './Icon.jsx';
import UMark from './UMark.jsx';

/**
 * The five "how it works" rows on the landing page.
 *
 * Each row is number / prose / aside, and the aside is a small still-life of the
 * thing the step describes rather than a stock illustration. Split out of
 * LandingPage so both files stay inside the size limit.
 *
 * The reply-rate figures in step 04 are INDUSTRY BENCHMARKS and are labelled as
 * such on the page. They are not ours and must not be presented as ours until
 * replyWatcher has measured real sends — see Decisions, 2026-08-15.
 */

// Instantly's 2026 benchmark report, both figures from the same denominator
// (replies ÷ emails sent): 3.43% platform average, 10.7%+ for the top decile.
// The fills are the two rates in proportion (3:11), scaled so the longer bar
// stops short of the track. A bar drawn at a literal 100% reads as "maxed out"
// rather than as a value, which overstates a number we are already reporting
// conservatively.
const BENCHMARK = {
  generic: { label: 'Generic blast', rate: 'reply 3%', fill: '22%' },
  personalized: { label: 'Written for one person', rate: 'reply 11%', fill: '82%' },
  source: 'Industry benchmarks · 2025–26'
};

function ConsentAside() {
  return (
    <div className="layerrow">
      <span className="layer">
        <Icon name="lock" className="red" /> Read-only scope
      </span>
      <span className="layer">
        <Icon name="shield-check" className="red" /> Revoke anytime
      </span>
    </div>
  );
}

function TwoLayersAside() {
  return (
    <div className="layerrow">
      <span className="layer">
        <span className="n">1</span> Read tone, rhythm, phrasing
      </span>
      <span className="layer">
        <span className="n">2</span> Re-check draft against you
      </span>
      <span className="miniclip">worth 15 minutes next week?</span>
    </div>
  );
}

function PipelineAside() {
  return (
    <div className="pipeline">
      <span className="node red">Goal</span>
      <span className="ar" aria-hidden="true">
        →
      </span>
      <span className="node">Find people</span>
      <span className="ar" aria-hidden="true">
        →
      </span>
      <span className="node">Background check</span>
      <span className="ar" aria-hidden="true">
        →
      </span>
      <span className="node red">Warm draft</span>
    </div>
  );
}

function BenchmarkBar({ label, rate, fill }) {
  return (
    <>
      <div className="row">
        <span>{label}</span>
        <span>{rate}</span>
      </div>
      <div className="track">
        <div className="fill" style={{ width: fill }} />
      </div>
    </>
  );
}

function BenchmarkAside() {
  return (
    <div className="bar">
      <BenchmarkBar {...BENCHMARK.generic} />
      <BenchmarkBar {...BENCHMARK.personalized} />
      {/* The attribution is part of the claim, not a footnote to it. */}
      <div className="barsrc">{BENCHMARK.source}</div>
    </div>
  );
}

function RegisterAside() {
  return (
    <div className="layerrow">
      <span className="layer">
        <Icon name="corner-up-left" className="green" /> Reply detection
      </span>
      <span className="layer">
        <Icon name="trending-up" className="red" /> Favors what works
      </span>
    </div>
  );
}

const STEPS = [
  {
    number: '01',
    label: 'Connect',
    heading: <>Connect your Gmail</>,
    body: 'One read-only connection. Unique reads your sent mail to learn your hand. Nothing else in your mailbox is touched, and nothing leaves your account without your say-so.',
    asideKey: 'Consent',
    Aside: ConsentAside
  },
  {
    number: '02',
    label: 'Learn',
    heading: (
      <>
        Generate your <em>voice profile</em>
      </>
    ),
    body: (
      <>
        We take down your last 100 sent emails and run them through two layers of analysis. The
        first reads tone, rhythm and habits; the second checks the draft back against <UMark />
        until it genuinely sounds like <UMark /> not an approximation.
      </>
    ),
    asideKey: 'Two layers',
    Aside: TwoLayersAside
  },
  {
    number: '03',
    label: 'Aim',
    heading: <>Give Unique the campaign goal</>,
    body: 'Tell it what the campaign is for. Unique finds the people who should receive it, runs a background check on each, and hyper-personalizes to what it learns, turning cold outreach warm before the first line is written.',
    asideKey: 'Goal → recipients',
    Aside: PipelineAside
  },
  {
    number: '04',
    label: 'Personalize',
    heading: (
      <>
        Every letter, written <em>for one person</em>
      </>
    ),
    body: (
      <>
        Each recipient gets an email in your voice, shaped by what the background check surfaced. A
        specific reason you&rsquo;re reaching out, not a mail-merge token. <UMark /> read the exact
        words before anything ships.
      </>
    ),
    asideKey: 'Cold → warm',
    Aside: BenchmarkAside
  },
  {
    number: '05',
    label: 'Adapt',
    heading: <>Track replies, adapt on the fly</>,
    body: 'Unique keeps the register of everything sent and who wrote back. When one approach outperforms another, it shifts toward what’s working, all inside Unique, online, for now.',
    asideKey: 'Live register',
    Aside: RegisterAside
  }
];

export default function LandingSteps() {
  return (
    <section className="steps">
      {STEPS.map(({ number, label, heading, body, asideKey, Aside }) => (
        <article className="step" key={number}>
          <div className="no">
            {number}
            <span className="lab">{label}</span>
          </div>
          <div>
            <h3>{heading}</h3>
            <p>{body}</p>
          </div>
          <div className="aside">
            <div className="k">{asideKey}</div>
            <Aside />
          </div>
        </article>
      ))}
    </section>
  );
}
