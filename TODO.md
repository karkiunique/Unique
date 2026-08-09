# Deferred work & next steps

Written as a handoff. Each entry says what is wrong or wanted, why it matters, and enough detail that
picking it up needs no re-investigation.

---

# NEXT, IN ORDER

**Phase 3 is COMPLETE.** Loops 1–4 are built, mutation-verified and committed.

**1. Wire `selectSendableLeads` into the send path** — the first thing Phase 4 must do. Detail below.
**2. Phase 4** — send queue, worker, unsubscribe route/page, reply watcher, dashboard.

**STOP: Phase 4 needs Redis**, which the repo owner installs manually. Do not scaffold a queue
against a Redis that is not running. Confirm Redis is up before starting.

---

## Where things stand

- Branch **`feat/phase-3`** (local only, not pushed), commit `4284279`.
- **810 tests green** — 584 server, 226 web. Baseline names in `.claude/last-green.txt`.
- Phase 3 Loops 1 (campaigns), 2 (CSV upload), 3 (batch generation) and 4 (review screen) are done.
- **Migration 003 is APPLIED and verified against the live DB** (2026-08-08) — both id columns exist
  and the unique index on `(user_id, gmail_message_id)` is real, confirmed by an `on_conflict` probe
  that returned an FK violation (execute-time) rather than `42P10` (plan-time). `recordSend()` was
  also exercised end-to-end against the live DB: write, idempotent retry, and both register readers.
  It works. **Migration 002's trigger was NOT verified** — `pg_catalog` is not reachable through
  PostgREST. Run this in the SQL Editor if certainty is wanted:
  ```sql
  select tgname, tgenabled from pg_trigger
  where tgrelid = 'auth.users'::regclass and not tgisinternal;
  ```

**How work gets done here:** every feature goes through the builder → checker loop
(`.claude/agents/`, `.claude/commands/build-loop.md`). Builder writes code and never runs anything;
checker runs everything and never edits. Both CLAUDE.md standing sections — **Code quality** and
**Privacy & data protection** — are enforced every cycle, and the privacy scan is a FAILED item, not
a warning.

**Green means new tests written AND the whole suite passing AND the source mutated to prove the tests
fail.** A green suite proved insufficient three times in the session that built Phase 1–2, and twice
more in Phase 3:

- Loop 3 shipped green at 497/497 with template mode's fidelity retry AND its banned-phrase retry
  both deletable without a single test failing — every retry test seeded voice mode, and template
  mode has its own copy of the machinery.
- Loop 4 shipped green at 579/579 with `classifyEdit` comparing word *count* but not word *identity*,
  so `"We cut onboarding time by half!"` → `"...by third."` was learned as "user removes exclamation
  marks" — a content rewrite permanently teaching the voice profile a rule the user never meant.

Both were found by mutating the source, never by the suite. **Mutate the source and confirm the test
fails.** Where a test can pass for the wrong reason, mutate in a way that preserves the outward
result and breaks only the invariant — that is how the two owner-filter holes on the regenerate path
were caught, since the outward 404 came from a different layer entirely.

---

# 1. `selectSendableLeads` has no caller — wire it in Phase 4

`server/src/services/leadReview.js` exports `selectSendableLeads`, the server-side enforcement of
"only `approved` leads may ever be sendable." It is fully tested (8 assertions, three mutations kill
it, including the full gate breach) but **nothing in production calls it** — no lead-based send path
exists yet, and `services/send.js` writes `lead_id: null` for one-off compose sends.

**The tests prove the function behaves. Nothing proves Phase 4 will actually route sending through
it.** That wiring is the risk, not the function. When `POST /campaigns/:id/send` is built, it must
select its leads through this function and not re-query `leads` itself, and a test must fail if it
stops doing so.

---

# 2. Phase 4 — carried-forward obligations

Recorded here so they are not rediscovered:

- **Reinstate the unsubscribe footer for batch sending.** The 2026-08-06 decision removes it from 1:1
  compose sends ONLY, and says explicitly it must not be carried into Phase 4 batch sending. For bulk
  commercial mail an opt-out is a legal expectation in several jurisdictions and a deliverability
  signal everywhere. `lib/unsubscribe.js`, the HMAC-signed token, `POST /unsubscribe/:token` and the
  public page all still exist for exactly this.
  - When it returns, consider an opaque lookup id rather than the old base64 `{userId, recipientEmail}`
    payload — it was HMAC-signed and unforgeable, but base64 is not encryption and any recipient could
    decode the sender's internal user id.
- **Bounce detection** is the real deliverability signal (2026-08-05 decision), feeding the `bounced`
  status already in the `leads` schema. MX checking is the cheap pre-send guess; bounces are the
  receiving server's own verdict. SMTP `RCPT TO` probing is **rejected, not deferred** — do not
  implement it.
- **Reply detection** (`replyWatcher.js`) works under `gmail.readonly` and labels nothing.
  `gmail.modify` remains deliberately unrequested.

---

# Known limitations (documented so they are not re-litigated)

## `server/src/services/generateBatch.js` is 373 lines

Over CLAUDE.md's "~300 lines, split when bigger." Left as-is deliberately: it had just been
mutation-verified across nine mutations, and splitting freshly-verified code is regression risk for
no behavioural gain. Split it the next time it is opened for a real change, not before.

## The compose flow's 80-point fidelity floor is enforced client-side only

`web/src/components/FidelityGate.jsx` blocks a sub-80 draft from reaching the confirm step. There is
no equivalent check in `routes/send.js` or `services/send.js`, so the floor is bypassable by a direct
API call.

This is **not** a violation of CLAUDE.md's non-negotiable, which requires the exact-content
confirmation gate to be server-side — and that one *is* server-side and mutation-verified. But the
floor itself is a UI-only gate, and this project's own history is that UI-only gates get bypassed.
Worth closing when the send path is next touched. Pre-existing; not introduced by Phase 3.

## The register cannot show sends that predate migration 003

Sends are identified as "ours" by the `gmail_message_id` / `gmail_thread_id` recorded in `send_log`
at send time. Anything sent before 003 was applied has no such row, and there is no way to recognise
it after the fact — which is precisely why the IDs are stored.

**Confirmed 2026-08-08: `send_log` is empty (0 rows).** Not a defect — the send path did not write to
`send_log` at all before commit `5e77283`, so any earlier test send left no row regardless of 003.
The next send made from the app will populate it and appear in the register.

## `ALLOWED_FIELDS` contains `name`

Today the only `name` ever logged is `err.name`, the Error class name — verified clean. But a future
`logger.info(evt, { name: campaign.name })` would pass the allowlist silently. Worth renaming to
`errorName` sometime. Pre-existing, low priority.

## Route-contract drift in CLAUDE.md

Loop 4's two new routes were added to CLAUDE.md's contract list. Several **pre-existing** routes are
still undocumented there: `PATCH /campaigns/:id`, `GET /me`, `GET /health`, `GET /dev/ingest-preview`,
`GET /voice/corpus-summary`, `POST /send`, `POST /send/generate`, `POST /send/verify-recipient`,
`GET /threads`, `GET /threads/:threadId`. Documented-but-unbuilt (Phase 4, expected):
`POST /campaigns/:id/send`, `POST /campaigns/:id/pause`, `GET /dashboard`. Worth one reconciliation
pass so "the routes in this doc are the contract" stays true.

## Dev-dependency vulnerabilities (accepted, per CLAUDE.md)

Production audits pass the gate in both apps: web 0 vulnerabilities; server 4 moderate, exactly the
accepted `uuid` → `gaxios` → `googleapis-common` → `googleapis@144.0.0` chain of the 2026-07-29
decision. Dev-only highs never shipped: `brace-expansion`, `js-yaml`, `nanoid`, and web's `vite`
(whose fix is a semver-major). Do not run `npm audit fix --force`.
