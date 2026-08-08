# Deferred work

Known issues that are understood, reproduced, and deliberately not fixed yet. Each entry says what
is wrong, why it matters, and what the fix is — so picking one up needs no re-investigation.

---

## The `Re:` prefix is added AFTER the user confirms a follow-up

**Status:** found 2026-08-06, deferred by request. Not fixed.

**What happens.** On a follow-up, the user reads and approves subject `X` in the confirmation dialog,
and `Re: X` is what actually leaves Gmail.

`server/src/services/send.js:227-231`

```js
const confirmedSubject = typeof input.subject === 'string' ? input.subject.trim() : '';
const subject =
  replyToThreadId === '' || confirmedSubject === ''
    ? confirmedSubject
    : withReplyPrefix(confirmedSubject);
```

`web/src/components/ConfirmSendDialog.jsx:51` sends exactly what it displayed:

```js
const payload = { to, subject, body, confirmed: true };
```

**Why it matters.** The dialog's copy is *"Exactly this leaves your Gmail. Nothing is rewritten after
you confirm."* That is now false for follow-ups. The rewrite itself is small and well-intentioned —
the risk is precedent. The byte-for-byte guarantee is the invariant the whole send path is built
around, and once the server may rewrite one approved field, the next rewrite has cover.

**The fix.** Apply `withReplyPrefix` **client-side**, before the dialog renders, so the displayed
subject *is* the delivered subject. `withReplyPrefix` is idempotent, so the existing server-side call
becomes a no-op and a follow-up still cannot be double-prefixed. Then assert in
`ConfirmSendDialog.test.jsx` that the follow-up subject shown equals the subject sent, the same way
the body already is.

**Second, smaller instance of the same class.** `input.subject.trim()` runs on *every* send, not just
follow-ups — another value modified after approval. Benign for a header, but worth folding into the
same fix. The body is correctly left untouched (only `.trim()`-tested for emptiness, never
reassigned).

---

## The register cannot show sends that predate migration 003

**Status:** inherent, not a bug. Documented so it is not re-litigated.

Sends are identified as "ours" by the `gmail_message_id` / `gmail_thread_id` recorded in `send_log`
at send time. Anything sent before 003 was applied has no such row, and there is no way to recognise
it after the fact — that is precisely why the IDs are stored. Those emails will never appear in the
register. Only sends made after 003 is applied will.

---

## Verification owed on the register rework

**Status:** the code is written and the suite is green (380 server + 126 web), but the checker was
killed three times mid-run (two connection errors, one session limit). These were never completed:

- adversarial probe of the confirmation gate with a **follow-up** payload
- cross-user isolation on `GET /threads/:threadId` by reproduction
- whether the renamed `threads.test.js` test still fails if the code reverts to an `in:sent` search
  (the checker was mid-mutation on exactly this when it died)
- Step 6 privacy scan over the message bodies the detail route now returns

Green tests are not sufficient here — three separate defects this session passed a fully green suite
and were found only by mutation testing. Run these before trusting the register.
