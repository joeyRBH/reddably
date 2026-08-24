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
-- These columns give the other four fields the same per-client default that
-- diagnosis_codes already had. clients.diagnosis_codes is deliberately NOT
-- renamed to default_diagnosis_codes: it already holds exactly this meaning and
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
