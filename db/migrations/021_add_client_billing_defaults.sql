-- =============================================================================
-- 021 — per-client billing defaults + calendar display name
-- =============================================================================
-- Makes "the clinician just verifies appointments" actually true.
--
-- A calendar-promoted appointment (backend/handlers/calendar_events.js) used to
-- insert a session with cpt_code, place_of_service, fee and procedure_modifiers
-- all NULL — the handler said so in as many words: "a calendar event carries
-- appointment facts, not billing data". Only diagnosis_codes carried over, from
-- the pre-existing clients.diagnosis_codes default (migration 008). So every
-- promoted session still needed billing data typed in by hand before it could
-- become a submittable claim, and the calendar integration saved the scheduling
-- step but none of the billing step.
--
-- These columns add four further per-client default fields to the client model,
-- analogous to the existing diagnosis default — each holds its OWN value; none
-- of them derives from diagnosis_codes. clients.diagnosis_codes is deliberately
-- NOT renamed to default_diagnosis_codes: it already holds exactly this meaning and
-- renaming a live PHI-adjacent column to gain naming symmetry is not worth the
-- migration risk. backend/lib/billing_fields.js maps the two naming styles in
-- one place (CLIENT_DEFAULT_COLUMNS).
--
-- calendar_display_name is separate in kind: it is the name the practice's EHR
-- writes into the Google Calendar event title when that differs from the
-- client's first/last name, fed to the matcher in backend/lib/calendar_match.js
-- as one additional comparison form. It is a display name for a patient, so it
-- is PHI and is treated as such (never logged, same at-rest encryption as the
-- rest of the clients row).
--
-- Money as numeric(12,2), matching sessions.fee and the repo-wide convention.
-- Every statement is idempotent (add column if not exists), so re-applying is a
-- no-op. No backfill: a NULL default simply means "no default", which is exactly
-- the behaviour every existing client has today.
-- =============================================================================

-- =============================================================================
-- DEPLOY ORDER — MIGRATION FIRST, THEN CODE.
-- =============================================================================
-- Nothing in this repo applies migrations automatically. db/README.md is
-- explicit that the schema is "applied to the RDS instance ... separately from
-- the Vercel frontend deploy", and the migrate Lambda
-- (backend/handlers/migrate.js) is a one-off that an operator invokes. So the
-- ordering is a HUMAN guarantee, not an enforced one.
--
-- Application code that reads or writes these columns must not reach production
-- before this migration has been applied:
--
--   1. Apply this migration (or db/schema.sql, which now carries the same
--      idempotent adds) against RDS.
--   2. VERIFY, from a VPC-attached shell:
--        select column_name, data_type, is_nullable, column_default
--          from information_schema.columns
--         where table_name = 'clients'
--           and column_name in ('default_cpt_code', 'default_place_of_service',
--                               'default_session_fee', 'default_procedure_modifiers',
--                               'calendar_display_name');
--      Expect 5 rows, every one is_nullable = YES and column_default = NULL.
--   3. Deploy the Lambda backend, then the Vercel frontend.
--
-- Getting it wrong fails LOUDLY rather than silently: the clients handler
-- SELECTs * and INSERTs these columns by name, so code-before-migration is an
-- immediate 42703 (undefined column) on client create/update, not corrupted
-- data. That is the better failure, but it is still an outage — do it in order.
-- =============================================================================

alter table clients add column if not exists default_cpt_code text;
alter table clients add column if not exists default_place_of_service text;
alter table clients add column if not exists default_session_fee numeric(12,2);
alter table clients add column if not exists default_procedure_modifiers text[];
alter table clients add column if not exists calendar_display_name text;

comment on column clients.default_cpt_code is
  'Default CPT code seeded onto new sessions for this client (calendar promote + manual create). Per-session override always wins.';
comment on column clients.default_place_of_service is
  'Default CMS place-of-service code (2 chars) seeded onto new sessions. Validated against lib/place_of_service.js on write.';
comment on column clients.default_session_fee is
  'Default session fee seeded onto new sessions; becomes the claim billed_amount unless overridden.';
comment on column clients.default_procedure_modifiers is
  'Default CMS-1500 Box 24D modifiers seeded onto new sessions (e.g. {95} for synchronous telehealth).';
comment on column clients.calendar_display_name is
  'PHI. The name this client appears under in the practice EHR''s calendar event titles, when it differs from first/last name. Used only as an extra comparison form by the calendar matcher; a match still never creates a billable session without human confirmation.';
