-- =============================================================================
-- Add procedure_modifiers to sessions.
-- =============================================================================
-- Payer-required procedure modifiers on the service line (CMS-1500 Box 24D, 837P
-- SV101-3..6). The most important is 95 for synchronous (real-time audio+video)
-- telehealth, which pairs with the telehealth place-of-service already stored on
-- the session (10 = patient home, 02 = other). A session carries at most 4
-- modifiers, each a two-character alphanumeric code; the backend validates and
-- normalizes (trim, uppercase, drop blanks, de-duplicate) before persisting, and
-- lib/clearinghouse/stedi.js attaches them to the service line's professionalService.
--
-- Modifiers are OPTIONAL and payer-specific — a stand-alone or non-telehealth
-- session leaves the column NULL, and the built claim omits the field entirely.
--
-- text[] mirrors sessions.diagnosis_codes. Idempotent / re-runnable. Keep in sync
-- with db/schema.sql (sessions table).
-- =============================================================================

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS procedure_modifiers text[];
