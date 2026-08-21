-- VoiceReach — migration 010: the waitlist baseline becomes real rows
--
-- WHY: the 88 was a display offset in code (WAITLIST_BASE_COUNT). This turns it into
-- 88 actual rows so the table reflects the number the site shows.
--
-- THE `seeded` FLAG IS NOT COSMETIC — IT IS A SAFETY INTERLOCK.
-- `waitlist.invited_at` exists so the go-live invite can page through everyone. Without
-- this flag that send would mail 88 fabricated addresses on day one, from a Postmark
-- sender with no reputation yet, and a bounce rate like that is how a transactional
-- domain gets throttled at the worst possible moment. EVERY query that sends mail to
-- the waitlist MUST filter `seeded = false`.
--
-- WHY RESERVED DOMAINS: every seeded address is at example.com / .net / .org (RFC 2606).
-- Those can never be delivered to and can never belong to a real person. So if the
-- filter above is ever forgotten, the worst case is a bounce into nowhere rather than
-- unsolicited mail to a stranger who never signed up. Realistic-looking addresses at
-- real domains would have made that mistake genuinely harmful instead of merely noisy.
--
-- WHY BACKDATED: a person's displayed number is their POSITION by created_at
-- (services/waitlist.js). Seeding at "now" would have put these rows after the real
-- signups and renumbered actual people down to No. 1-6. Every seeded row therefore sits
-- before 2026-08-15T15:37:53Z, the first real signup, which keeps uniquekarki101 at
-- No. 89 exactly as they were told.
--
-- Note `seat` is NOT set here: it is `generated always as identity`, so these rows take
-- seats 97+ while sitting at positions 1-88. That is harmless — nothing user-facing
-- reads `seat` (Decisions, 2026-08-19) — but it is why the two no longer correspond.
--
-- WITH THIS APPLIED, WAITLIST_BASE_COUNT BECOMES 0 IN CODE. The rows now carry the
-- baseline; leaving the offset at 88 would display 88 + 94 = 182.
--
-- Idempotent: the column is `if not exists` and the insert is `on conflict do nothing`.

alter table public.waitlist add column if not exists seeded boolean not null default false;

-- Partial index: every real-mail query filters on this, and it selects a small subset.
create index if not exists waitlist_real_signups_idx
  on public.waitlist (created_at) where not seeded;

insert into public.waitlist (email, created_at, seeded) values
  ('suri.vogel@example.net', '2026-06-01T00:08:11Z', true),
  ('otis.kowal@example.com', '2026-06-01T04:50:33.612586Z', true),
  ('leilani.hale@example.net', '2026-06-01T11:29:33.435377Z', true),
  ('alina.fenwick@example.com', '2026-06-01T20:07:19.750544Z', true),
  ('elsa.ashby@example.org', '2026-06-02T05:11:36.814231Z', true),
  ('asher.njoku@example.com', '2026-06-02T15:19:09.481871Z', true),
  ('marit.dias@example.net', '2026-06-03T01:56:48.333660Z', true),
  ('mirembe.nakashima@example.com', '2026-06-03T12:43:43.845187Z', true),
  ('emil.bello@example.com', '2026-06-04T00:43:57.880013Z', true),
  ('amara.dunne@example.com', '2026-06-04T13:18:20.811887Z', true),
  ('felix.costa@example.net', '2026-06-05T02:46:08.098040Z', true),
  ('arlo.conte@example.com', '2026-06-05T16:07:48.277184Z', true),
  ('noah.lindgren@example.org', '2026-06-06T05:29:44.032297Z', true),
  ('leilani.udo@example.org', '2026-06-06T19:45:27.100593Z', true),
  ('liam.cardoso@example.org', '2026-06-07T11:05:55.355222Z', true),
  ('isla.sinclair@example.net', '2026-06-08T01:31:24.661758Z', true),
  ('rune.haugen@example.com', '2026-06-08T17:28:58.264976Z', true),
  ('kwame.olsen@example.net', '2026-06-09T08:24:29.549268Z', true),
  ('noah.ferro@example.com', '2026-06-10T00:33:36.068953Z', true),
  ('yara.rios@example.org', '2026-06-10T17:09:43.777798Z', true),
  ('povilas.okafor@example.com', '2026-06-11T10:21:20.408348Z', true),
  ('theo.andersen@example.org', '2026-06-12T02:58:50.965833Z', true),
  ('iris.ibrahim@example.net', '2026-06-12T20:12:02.310972Z', true),
  ('kai.bakker@example.net', '2026-06-13T13:55:14.812709Z', true),
  ('fern.sinclair@example.com', '2026-06-14T07:16:42.056575Z', true),
  ('amara.koenig@example.org', '2026-06-15T01:47:41.597813Z', true),
  ('soren.njoku@example.org', '2026-06-15T19:47:59.750858Z', true),
  ('nadia.ibrahim@example.com', '2026-06-16T14:22:18.408616Z', true),
  ('romy.rios@example.org', '2026-06-17T08:56:16.886366Z', true),
  ('yara.osei@example.org', '2026-06-18T04:19:22.786162Z', true),
  ('alma.dias@example.net', '2026-06-18T23:58:29.878429Z', true),
  ('ethan.kowal@example.net', '2026-06-19T18:56:57.998066Z', true),
  ('lasse.conte@example.net', '2026-06-20T15:02:45.952856Z', true),
  ('romy.moreau@example.com', '2026-06-21T11:12:13.442404Z', true),
  ('soren.lindgren@example.org', '2026-06-22T07:16:11.986080Z', true),
  ('joaquin.banerjee@example.com', '2026-06-23T03:08:43.858764Z', true),
  ('aoife.abbott@example.org', '2026-06-23T23:58:44.033311Z', true),
  ('emil.olsen@example.com', '2026-06-24T20:19:37.128896Z', true),
  ('niall.chukwu@example.com', '2026-06-25T17:43:07.364477Z', true),
  ('oleg.conte@example.org', '2026-06-26T14:43:45.516753Z', true),
  ('mia.nakashima@example.net', '2026-06-27T12:43:01.882077Z', true),
  ('asher.amara@example.net', '2026-06-28T09:51:59.241861Z', true),
  ('ethan.sinclair@example.org', '2026-06-29T07:14:33.831074Z', true),
  ('kofi.ferro@example.org', '2026-06-30T05:21:02.309500Z', true),
  ('delphine.holloway@example.org', '2026-07-01T03:09:13.735429Z', true),
  ('emeka.duval@example.net', '2026-07-02T01:54:26.541562Z', true),
  ('owen.banerjee@example.org', '2026-07-03T00:44:03.512861Z', true),
  ('hiro.boyle@example.com', '2026-07-03T23:07:52.766174Z', true),
  ('vera.reyes@example.com', '2026-07-04T21:36:01.731443Z', true),
  ('soren.haruna@example.com', '2026-07-05T20:58:22.134356Z', true),
  ('kofi.ibrahim@example.org', '2026-07-06T19:40:14.980284Z', true),
  ('otis.malik@example.org', '2026-07-07T19:34:07.539403Z', true),
  ('piet.stroud@example.org', '2026-07-08T18:40:20.332887Z', true),
  ('siv.ibrahim@example.com', '2026-07-09T17:57:35.120062Z', true),
  ('alina.rahman@example.com', '2026-07-10T17:50:37.886466Z', true),
  ('lark.mensah@example.net', '2026-07-11T17:21:38.832701Z', true),
  ('piet.mensah@example.net', '2026-07-12T18:11:42.364038Z', true),
  ('marit.sorensen@example.org', '2026-07-13T18:35:25.080699Z', true),
  ('juno.calloway@example.org', '2026-07-14T18:32:31.768765Z', true),
  ('alma.gallagher@example.net', '2026-07-15T18:42:35.391654Z', true),
  ('wren.rios@example.com', '2026-07-16T19:31:03.082131Z', true),
  ('dario.krishnan@example.org', '2026-07-17T19:58:07.134808Z', true),
  ('lark.cardoso@example.net', '2026-07-18T21:19:00.999086Z', true),
  ('anouk.osei@example.org', '2026-07-19T22:22:28.272526Z', true),
  ('alina.mihailov@example.net', '2026-07-20T23:33:15.694590Z', true),
  ('tess.okafor@example.net', '2026-07-22T01:15:53.140756Z', true),
  ('edie.okafor@example.com', '2026-07-23T02:37:49.616953Z', true),
  ('lena.strand@example.net', '2026-07-24T04:20:22.254307Z', true),
  ('piet.obi@example.net', '2026-07-25T06:06:40.304180Z', true),
  ('tess.mbeki@example.net', '2026-07-26T07:45:19.133467Z', true),
  ('edie.rasmussen@example.org', '2026-07-27T10:19:31.220149Z', true),
  ('nell.serrano@example.com', '2026-07-28T12:29:31.149075Z', true),
  ('jonas.holloway@example.com', '2026-07-29T14:13:35.607967Z', true),
  ('alma.obi@example.org', '2026-07-30T16:20:07.383617Z', true),
  ('leilani.abbott@example.com', '2026-07-31T19:15:30.358290Z', true),
  ('emil.haruna@example.com', '2026-08-01T21:57:59.506287Z', true),
  ('elsa.dunne@example.org', '2026-08-03T00:50:53.890692Z', true),
  ('stefan.duval@example.org', '2026-08-04T03:41:45.660268Z', true),
  ('anouk.murray@example.net', '2026-08-05T06:59:03.046498Z', true),
  ('tess.ibrahim@example.net', '2026-08-06T10:04:27.360769Z', true),
  ('tobias.reyes@example.net', '2026-08-07T13:30:18.991690Z', true),
  ('leilani.costa@example.com', '2026-08-08T17:07:14.402520Z', true),
  ('jonah.sorensen@example.com', '2026-08-09T20:34:53.128727Z', true),
  ('oleg.delacroix@example.com', '2026-08-10T23:58:38.775646Z', true),
  ('greta.abbott@example.com', '2026-08-12T03:19:20.016244Z', true),
  ('idris.eriksen@example.net', '2026-08-13T07:49:06.588982Z', true),
  ('joaquin.obi@example.net', '2026-08-14T11:45:33.295768Z', true),
  ('yara.ashby@example.com', '2026-08-15T15:00:00Z', true)
on conflict (email) do nothing;

-- ---------------------------------------------------------------------------
-- verification — commented out on purpose so pasting this file applies the migration only.
-- ---------------------------------------------------------------------------

-- -- 1. 88 seeded, and your real signups untouched
-- select seeded, count(*) from public.waitlist group by seeded;

-- -- 2. the displayed count is now just the row count
-- select count(*) as shown_on_the_site from public.waitlist;

-- -- 3. the first REAL signup must still be No. 89
-- select count(*) as position from public.waitlist
-- where created_at <= (select min(created_at) from public.waitlist where not seeded);

-- -- 4. nothing seeded can ever be delivered to (expect 0)
-- select count(*) from public.waitlist
-- where seeded and email not like '%@example.com'
--   and email not like '%@example.net' and email not like '%@example.org';
