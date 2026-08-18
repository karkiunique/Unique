# Deferred work & next steps

Written as a handoff. Each entry says what is wrong or wanted, why it matters, and enough detail that
picking it up needs no re-investigation.

---

# NEXT, IN ORDER

**Phase 3 is COMPLETE.** Loops 1–4 are built, mutation-verified and committed.

## ⛔ PHASE 4 BLOCKERS — read before writing a single line of Phase 4 code

Two gate-integrity requirements, both recorded as dated decisions in CLAUDE.md. **Neither is a
cleanup.** Phase 4 is where sending becomes autonomous, and these are the two places where the
human-approval guarantee can be silently lost. Do not treat them as follow-ups to fit in later.

**BLOCKER 1 — every send MUST route through `selectSendableLeads`. Top wiring requirement of Phase 4.**
It is the server-side enforcement of "only `approved` leads may ever be sendable", fully tested and
mutation-verified (three mutations kill it, including the full gate breach) — but it has **no
production caller**. The tests prove the function behaves; nothing yet proves the send path uses it.

**Building the Phase 4 queue without routing through it = autonomous sending with the approval gate
bypassed.** That is not hypothetical here: this project already shipped a trailing-slash route
variant that sent email with no confirmation and passed a fully green 32-test suite.

`POST /campaigns/:id/send` and `sendWorker.js` must select leads through this function and must not
re-query `leads` themselves. A test must FAIL if they stop doing so — **assert on the call, not the
outcome**, because a re-query can return an identical result set while bypassing the gate entirely.
Outcome-based assertions are provably blind to this class of bug; that is exactly how the two
regenerate-path owner filters survived their first mutation round in Loop 4.

**BLOCKER 2 — harden the compose 80-point fidelity floor server-side, when the send path is touched.**
`web/src/components/FidelityGate.jsx` blocks a sub-80 draft from reaching the confirm step. Nothing in
`routes/send.js` or `services/send.js` does, so the floor is bypassable by a direct API call.

Not a CLAUDE.md violation — the non-negotiable requires the exact-content *confirmation* gate to be
server-side, and that gate is server-side and mutation-verified. But the fidelity floor is a UI-only
gate, and this repo's history on UI-only gates is unambiguous.

**Preserve the escape hatch when hardening it:** per CLAUDE.md § 3, once the user manually edits the
body the score goes stale and the gate lifts — the words are theirs at that point. A server-side floor
that ignores this traps users behind a score the model cannot reach.

## Then

**Phase 4** — send queue, worker, unsubscribe route/page, reply watcher, dashboard.

**STOP: Phase 4 needs Redis**, which the repo owner installs manually. Do not scaffold a queue
against a Redis that is not running. Confirm Redis is up before starting.

## And keep flagging contract drift

Loop 4 added two routes and they were built before being recorded in CLAUDE.md — backwards from the
stated process, since the route list in that file **is** the contract. Record a route in CLAUDE.md
*before* building it, and say so out loud when it is about to happen the other way round.

---

## Where things stand

- Branch **`feat/phase-3`** (local only, not pushed), commit `4284279`.
- **810 tests green** — 584 server, 226 web. Baseline names in `.claude/last-green.txt`.
- Phase 3 Loops 1 (campaigns), 2 (CSV upload), 3 (batch generation) and 4 (review screen) are done.
- **Migration 003 is APPLIED and verified against the live DB** (2026-08-08) — both id columns exist
  and the unique index on `(user_id, gmail_message_id)` is real, confirmed by an `on_conflict` probe
  that returned an FK violation (execute-time) rather than `42P10` (plan-time). `recordSend()` was
  also exercised end-to-end against the live DB: write, idempotent retry, and both register readers.
  It works.
- **Migration 002's trigger IS VERIFIED** (2026-08-17), and so is 006's replacement of it. Reading
  `pg_trigger` through PostgREST is still impossible — it answers `PGRST205` — so it was tested
  FUNCTIONALLY instead, which is better evidence anyway: reading the catalog proves a trigger exists,
  running one proves it works. A throwaway user was created through `auth.admin.createUser` with
  `full_name` in the metadata, and:
    - a `profiles` row appeared automatically  -> the 002 trigger fires;
    - `email` carried through correctly;
    - `full_name` came back as the metadata value -> the **006** version of `handle_new_user` is the
      one installed, not the 002 version;
    - deleting the auth user cascaded the `profiles` row away, leaving no orphan.
  The probe user was removed. Re-run it the same way if the trigger is ever suspected again.
- **Migration 006 was UNAPPLIED until 2026-08-17**, long after it merged to `main` in `b3b4734`.
  `profiles.full_name` simply did not exist, so `PATCH /me` failed and the sign-off name was inert in
  production while the code and the contract both said it worked. Found only because a script tried
  to read the column. **A migration merged is not a migration applied** — check the live schema after
  merging one, not just that the file is in the repo.

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

# 1. Phase 4 — carried-forward obligations

**The two hard blockers are at the top of this file. This section is the rest.**

Supporting detail for BLOCKER 1: `selectSendableLeads` lives in
`server/src/services/leadReview.js` with 8 assertions behind it. No lead-based send path exists yet —
`services/send.js` writes `lead_id: null` for one-off compose sends — which is why it currently has
no caller.

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

## An intermittent failure in `campaignRoutes.test.js` auth tests — SEEN TWICE

Two sightings, both on supertest auth tests in the same file, both unreproducible afterwards:

1. `campaign routes — authentication > 401s on every campaign route without a token` — `Error: socket hang up`. Did not reproduce in 5 subsequent runs.
2. `POST /api/campaigns/:id/leads > 401s without a token, without reaching the service` — `expected 404 to be 401`. Did not reproduce in ~28 runs, including shuffled ordering, under concurrent load, and in isolation (43/43).

**It is not a product defect.** `requireAuth` returns 401 unconditionally when the header is absent, with no fall-through, and the route is registered statically — so a 404 means the request never reached the campaigns router at all. Both sightings were on a cold, CPU-contended first run.

**Leading hypothesis:** ephemeral-port reuse in `supertest` under parallel vitest workers, where a request lands on a different worker's app whose catch-all returns exactly `404 {error:'Not found'}`. That matches the observed status precisely. **Unproven.**

**Why it matters now:** Phase 4 adds a queue and a worker, i.e. real concurrency and real timing. A test that already fails occasionally for unpinned reasons will be far harder to diagnose once genuine async is in the mix, and it will erode trust in the suite exactly when the suite is guarding autonomous sending. Worth pinning down before Phase 4, not after — likely by giving supertest an explicit listening server per test rather than letting it pick a port.

## `server/src/services/generateBatch.js` is 373 lines

Over CLAUDE.md's "~300 lines, split when bigger." Left as-is deliberately: it had just been
mutation-verified across nine mutations, and splitting freshly-verified code is regression risk for
no behavioural gain. Split it the next time it is opened for a real change, not before.

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
