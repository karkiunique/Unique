import Icon from './Icon.jsx';

/**
 * One line of the register.
 *
 * It is a button rather than a row of text: the whole line opens the thread, so
 * the hit target is the line the eye is already on and not a link buried inside
 * it. Everything shown comes from the API response — this component derives no
 * threads of its own and hides none, because "only mail we sent" is a guarantee
 * the server makes and the client must not quietly reinterpret.
 */

const UNKNOWN_SENT = { date: 'Unknown', time: '' };

/** Date and time as two lines, or a flat "Unknown" if the value is unusable. */
function sentParts(value) {
  if (typeof value !== 'string' || value === '') return UNKNOWN_SENT;

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return UNKNOWN_SENT;

  const at = new Date(parsed);

  return {
    date: at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase(),
    time: at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  };
}

function subjectOf(thread) {
  const subject = thread?.subject;
  return typeof subject === 'string' && subject.trim() !== '' ? subject : '(no subject)';
}

export default function RegisterRow({ thread, position, onOpen }) {
  const sent = sentParts(thread?.sentAt);
  const replied = Boolean(thread?.replied);
  const threadId = typeof thread?.threadId === 'string' ? thread.threadId : '';

  function open() {
    if (threadId === '' || typeof onOpen !== 'function') return;
    onOpen(threadId);
  }

  return (
    <button type="button" className={replied ? 'reg-row replied' : 'reg-row'} onClick={open}>
      <span className="reg-no">{String(position + 1).padStart(2, '0')}</span>

      <span className="reg-subject">
        <span className="t">{subjectOf(thread)}</span>
        <span className="a">{typeof thread?.to === 'string' ? thread.to : ''}</span>
      </span>

      <span className="reg-sent">
        {sent.date}
        <span className="time">{sent.time}</span>
      </span>

      <span className="reg-status">
        {replied ? (
          <span className="tag outline">
            <Icon name="corner-up-left" />
            Replied
          </span>
        ) : (
          <span className="mono reg-awaiting">· · ·</span>
        )}
      </span>
    </button>
  );
}
