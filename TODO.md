# Deferred work & next steps

Written as a handoff. Each entry says what is wrong or wanted, why it matters, and enough detail that
picking it up needs no re-investigation.

---

# NEXT, IN ORDER

**1. Fix the `Re:` prefix defect** — gate-integrity fix, do this first. Detail below.
**2. Phase 3, Loop 3** — batch generation in the user's voice.
**3. Phase 3, Loop 4** — review screen with real per-lead approval.

**STOP before Phase 4.** It needs Redis, which the repo owner installs manually. Do not scaffold a
queue against a Redis that is not running.

---

## Where things stand

- Branch **`feat/phase-3`** (local only, not pushed), commit `7ea2e18`. `feat/phase-2` holds
  everything up to and including the register rework.
- **636 tests green** — 452 server, 184 web. Baseline names in `.claude/last-green.txt`.
- Phase 3 Loop 1 (campaigns) and Loop 2 (CSV lead upload) are done and verified.
- **Migrations 002 and 003 were handed to the repo owner to paste into the Supabase SQL Editor.**
  Confirm they were actually applied before trusting the register or lead upload — 003 adds the
  `send_log` id columns the register reads, and without it the register stays empty.

**How work gets done here:** every feature goes through the builder → checker loop
(`.claude/agents/`, `.claude/commands/build-loop.md`). Builder writes code and never runs anything;
checker runs everything and never edits. Both CLAUDE.md standing sections — **Code quality** and
**Privacy & data protection** — are enforced every cycle, and the privacy scan is a FAILED item, not
a warning.

**Green means new tests written AND the whole suite passing.** A green suite proved insufficient
three separate times in the session that built this: a Node 20 crash that 166 mocked tests missed, a
signature-stripping fix that silently deleted real prose while passing 198 tests, and a trailing-slash
route that sent email with no confirmation and passed all 32. Each was found by mutation testing, not
by the suite. Mutate the source and confirm the test fails.

---

# 1. The `Re:` prefix is added AFTER the user confirms a follow-up

**Status:** found 2026-08-06, reproduced, deferred by request. **Do this first.**

**What happens.** On a follow-up the user reads and approves subject `X`, and `Re: X` is what actually
leaves Gmail.

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
you confirm."* That is false for follow-ups today. The rewrite is small and well-intentioned — the
risk is precedent. Byte-for-byte is the invariant the whole send path is built around, and once the
server may rewrite one approved field, the next rewrite has cover.

**The fix.** Apply `withReplyPrefix` **client-side, before the dialog renders**, so the displayed
subject *is* the delivered subject. `withReplyPrefix` is idempotent, so the existing server-side call
becomes a no-op and a follow-up still cannot be double-prefixed.

**The test that must exist afterwards:** assert in `ConfirmSendDialog.test.jsx` that for a follow-up
the subject **shown** equals the subject **sent**, byte-for-byte — the same guarantee the body already
has. It must fail if the prefix moves back to the server.

**Second, smaller instance of the same class.** `input.subject.trim()` runs on *every* send, not just
follow-ups — another value modified after approval. Benign for a header, but fold it into the same
fix. The body is correctly left untouched (only `.trim()`-tested for emptiness, never reassigned).

---

# 2. Phase 3, Loop 3 — batch generation

Generate an email for every pending lead on a campaign, in the user's voice. See CLAUDE.md § 3
Generation — it is the authority; the notes below are the parts that bite.

- **Both modes.** Voice mode: profile JSON + exemplars + lead data + campaign goal. Template mode:
  merge vars (`{{first_name}}`, `{{company}}`, `{{title}}`) are substituted **in code, not by the
  model** — only `{{personalized}}` sections go to Claude. A missing merge var for a lead means that
  lead is flagged `failed` with a reason; it must never send with a blank or wrong substitution.
- **Few-shot anchoring is mandatory in voice mode.** Decrypted exemplars go in every generation
  prompt, in memory only, never logged.
- **Fidelity check pass**, score `<80` → regenerate once with violations fed back; still `<80` →
  store the score and flag it for review rather than blocking. Note this is the BATCH rule and is
  deliberately looser than the compose flow's hard floor of 80 (CLAUDE.md § 3 explains why).
- **Every generated email signs off as the user, by name** — the guardrail already exists in
  `services/signoff.js`; reuse it, do not reimplement.
- **Sequential with `p-limit` concurrency 3**, updating each lead row as it completes so the UI can
  poll progress. `p-limit` is not installed yet — the orchestrator installs it, exact-pinned, and
  reports it for approval.
- **No unsubscribe footer** on these either, per the 2026-08-06 decision — but see that decision:
  the footer *must* be reinstated for Phase 4 batch **sending**, which is a different thing from
  batch generation.
- Failure modes worth their own tests: a lead with a missing merge var, a malformed model response,
  a model call that throws mid-batch (the rest of the batch must still complete), and a lead that
  fails fidelity twice.

---

# 3. Phase 3, Loop 4 — review screen

**This is the batch-approval gate, and it carries the same weight as the single-send confirm gate.**

Once Phase 4 makes sending autonomous, this screen is the last place a human sees an email before it
goes out under their name. Treat it accordingly:

- **Every lead must be individually viewable and individually approvable.** No bulk "approve all"
  that lets a lead reach `approved` without having been rendered for a human. If an Approve All
  exists at all, it must only apply to leads the user has actually opened.
- **Only `approved` leads may ever be sendable.** Enforce the transition **server-side** — a UI-only
  gate is bypassable, which is exactly the lesson from the compose flow, where a trailing-slash route
  variant sent email with no confirmation and passed a fully green suite.
- Editable subject and body per lead; the user's edit wins over the generated text (`edited_body`).
- Surface the fidelity score, and flag `<80` visibly as "low fidelity — read closely".
- Regenerate one lead without disturbing the rest.
- **Edit-learning loop** (CLAUDE.md § 3): when a user edits a generated email, diff generated vs
  edited; if the change is stylistic rather than content, append a note to
  `profile_json.learned_corrections[]`, capped at 20, FIFO.

Tests that must exist: a lead cannot reach `approved` without an explicit per-lead approval; the
server rejects an approval for a lead belonging to another user; an edited body is what gets stored
and later sent; and the approval endpoint is owner-scoped like every other data route.

---

# Known limitations (documented so they are not re-litigated)

## The register cannot show sends that predate migration 003

Sends are identified as "ours" by the `gmail_message_id` / `gmail_thread_id` recorded in `send_log`
at send time. Anything sent before 003 was applied has no such row, and there is no way to recognise
it after the fact — which is precisely why the IDs are stored. Those emails will never appear in the
register. Only sends made after 003 is applied will.

## Verification owed on the register rework — **CLEARED 2026-08-07**

All four outstanding items came back GREEN, verified by reproduction and mutation rather than by
reading: the confirmation gate under a follow-up payload (30 bypass shapes blocked, with positive
controls), cross-user isolation on `GET /threads/:threadId` (reproduced with two users whose threads
both exist in Gmail, so ownership was the only variable), the renamed `threads.test.js` test (fails
under a reverted `in:sent` search, and is strictly broader than what it replaced), and the privacy
scan over the message bodies the detail route returns.

## `ALLOWED_FIELDS` contains `name`

Today the only `name` ever logged is `err.name`, the Error class name — verified clean. But a future
`logger.info(evt, { name: campaign.name })` would pass the allowlist silently. Worth renaming to
`errorName` sometime. Pre-existing, low priority.
