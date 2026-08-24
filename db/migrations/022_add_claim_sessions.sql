-- =============================================================================
-- 022 — claim_sessions: one 837P claim carrying several dates of service
-- =============================================================================
-- MONEY-PATH MIGRATION. Read db/migrations/README or the PR before applying.
--
-- Until now a claim was strictly 1:1 with a session, and the Stedi adapter built
-- exactly one serviceLines entry from it. A client with ten sessions in a month
-- therefore produced ten separate claims — and ten separate off-session Stripe
-- PaymentIntents for the 5% platform fee, so the patient saw ten line items on
-- their card statement for what is, to them, one month of therapy.
--
-- A CMS-1500 has always been able to carry several dates of service: Box 24 has
-- six service lines, each with its own date, procedure code and charge. This
-- table is that relationship.
--
--   claims.session_id      STAYS, and is the ANCHOR session (the earliest one on
--                          the claim). Every existing join, readiness query and
--                          report keeps working untouched — this migration adds
--                          a relationship, it does not move one.
--   claim_sessions         every session on the claim, including the anchor, one
--                          row per 837P service line.
--
-- The fee follows for free: claim_fee.js computes 5% of claims.billed_amount,
-- and a grouped claim's billed_amount is the SUM of its lines. Same total
-- dollars, one charge instead of N. No fee logic changes in this migration.
--
-- DEPLOY ORDER — MIGRATION FIRST, THEN CODE. Nothing here migrates
-- automatically (db/README.md; backend/handlers/migrate.js is operator-invoked).
--   1. Apply this migration.
--   2. VERIFY, from a VPC-attached shell. Each query states its own expected
--      result; anything else means STOP and do not deploy the code.
--
--      (a) Every claim has at least one service line. This is THE invariant the
--          backfill exists to establish — it is what lets the builder, the
--          readiness projection and the detail view run one code path instead of
--          branching on "grouped or legacy".
--            select count(*) as claims_without_lines
--              from claims c
--             where not exists (select 1 from claim_sessions cs
--                                where cs.claim_id = c.id);
--            -- EXPECT 0
--
--      (b) Immediately after this migration, every claim has EXACTLY one line
--          (nothing has been grouped yet).
--            select count(*) as claims_with_extra_lines from (
--              select cs.claim_id from claim_sessions cs
--               group by cs.claim_id having count(*) > 1
--            ) t;
--            -- EXPECT 0 immediately after applying; grows legitimately once
--            -- staff start grouping.
--
--      (c) MONEY CHECK. For a backfilled 1:1 claim the line charge IS the claim
--          charge, so the two must agree everywhere. A mismatch here would mean
--          the very first 837P built from that claim is refused by the builder's
--          line-sum invariant.
--            select count(*) as charge_mismatches
--              from claims c join claim_sessions cs on cs.claim_id = c.id
--             where cs.line_charge is distinct from c.billed_amount;
--            -- EXPECT 0
--
--      NOTE: do NOT compare count(*) on claim_sessions against the count of
--      NON-HIDDEN claims. The backfill deliberately covers hidden (soft-deleted)
--      claims too, so the row count matches ALL claims. Comparing against the
--      visible subset reads as a failed migration when nothing is wrong.
--
--   3. Deploy the Lambda backend, then the Vercel frontend.
-- Code-before-migration fails loudly (42P01 undefined table) on claim submit
-- rather than mis-billing anything, but it is still an outage — do it in order.
-- =============================================================================

create table if not exists claim_sessions (
  id           uuid primary key default gen_random_uuid(),
  practice_id  uuid not null references practices (id) on delete restrict,
  -- CASCADE mirrors claim_events: a service line has no meaning without its
  -- claim. The session reference stays RESTRICT — the session is a real clinical
  -- and financial record and must never be removed because a claim went away.
  claim_id     uuid not null references claims (id) on delete cascade,
  session_id   uuid not null references sessions (id) on delete restrict,
  -- The charge for THIS line (837P SV102 / CMS-1500 Box 24F). Copied from the
  -- session's fee when the line is created, so the claim's billed_amount is
  -- exactly the sum of its lines and cannot drift if a session's fee is edited
  -- afterwards. The 837P requires the line charges to sum to the claim charge;
  -- a mismatch is a payer front-door rejection.
  line_charge  numeric(12,2),
  -- Service-line order on the form (1-based). Stable, so a resubmission emits
  -- the lines in the same order and the 277CA/835 line references still align.
  position     integer not null default 1,
  created_at   timestamptz not null default now(),
  -- A session may legitimately appear on SEVERAL claims — a replacement claim
  -- (CMS frequency 7) is a new claim over the same service, and claims have
  -- always allowed that. What must never happen is the same session appearing
  -- TWICE on ONE claim, which would bill the payer for it twice.
  unique (claim_id, session_id)
);
comment on table claim_sessions is
  'Service lines of a claim: one row per session billed on it (837P 2400 / CMS-1500 Box 24). A claim may carry several dates of service for one client; claims.session_id remains the anchor (earliest) session.';
comment on column claim_sessions.line_charge is
  'Charge for this service line (SV102 / Box 24F), copied from the session fee at creation. The claim''s billed_amount is the sum of these; a mismatch is rejected by the payer.';
comment on column claim_sessions.session_id is
  'RESTRICT, not CASCADE: a session is a real record in its own right. The same session may appear on several claims (replacement/appeal), but never twice on one.';

create index if not exists idx_claim_sessions_practice_id on claim_sessions (practice_id);
create index if not exists idx_claim_sessions_claim_id on claim_sessions (claim_id);
create index if not exists idx_claim_sessions_session_id on claim_sessions (session_id);

-- Backfill: every pre-existing claim becomes a one-line claim over its own
-- session, so there is ONE code path rather than "grouped claims" and "old
-- claims". line_charge takes the claim's billed_amount, which for a 1:1 claim IS
-- the line charge. Idempotent via NOT EXISTS, so re-applying is a no-op.
insert into claim_sessions (practice_id, claim_id, session_id, line_charge, position)
select c.practice_id, c.id, c.session_id, c.billed_amount, 1
  from claims c
 where not exists (
   select 1 from claim_sessions cs where cs.claim_id = c.id
 );
