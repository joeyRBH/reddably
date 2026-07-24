-- =============================================================================
-- Dependent-subscriber (policyholder) address + gender, and a claim-level prior
-- authorization number.
-- =============================================================================
-- Two additions some behavioral-health payers require:
--
--   * The POLICYHOLDER's demographics on a DEPENDENT claim (CMS-1500 Box 7 /
--     11a). When the patient is a dependent on someone else's policy, the 837P
--     puts the policyholder in the subscriber loop; some payers reject the claim
--     unless that subscriber carries a gender and full address. The dependent
--     branch previously sent only the policyholder's name, DOB, and member id.
--     These live on insurance_records (the policyholder is a property of the
--     policy) alongside the existing subscriber_name / subscriber_dob.
--
--   * A prior authorization number (CMS-1500 Box 23 / 837P claim-level REF*G1).
--     This is CLAIM-LEVEL, NOT a property of the policy: an authorization is
--     specific to a course of treatment / date range / service / provider / unit
--     count. Storing one mutable number on insurance_records would leak it onto
--     unrelated claims drawn from the same policy, so it lives on claims and is
--     captured per claim in the submit flow (copied into the immutable submission
--     context like the replacement-claim fields in migration 018). A future
--     authorization entity can model date ranges / CPT / remaining units — out of
--     scope here.
--
-- The subscriber_gender vocabulary matches clients.gender (migration 002):
-- 'female' | 'male' | 'unknown'. The Stedi adapter maps each to the 837
-- demographic code (F / M / U) via the same genderCode() helper the non-dependent
-- subscriber branch already uses. All of these columns are PHI.
--
-- These fields are OPTIONAL: the adapter omits gender / address / priorAuth
-- entirely from the built 837P body when unset (never '' / null), so ordinary
-- claims are structurally unchanged. Payer/Stedi validation — not a universal
-- NOT NULL here — decides when they are required.
--
-- Idempotent / re-runnable (add column if not exists, guarded CHECK).
-- Mirrored in db/schema.sql (§6 insurance_records, §8 claims) — schema.sql is the
-- only path to a fresh prod database.
-- NOT auto-applied on deploy: an operator runs it via the claimsub-prod-migrate
-- Lambda. See db/migrations/README.md.
-- =============================================================================

-- Claim-level prior authorization number (Box 23 / 837P claim-level REF*G1).
alter table claims add column if not exists prior_authorization_number text;

-- Dependent-subscriber (policyholder) address (Box 7).
alter table insurance_records add column if not exists subscriber_address_line1 text;
alter table insurance_records add column if not exists subscriber_address_line2 text;
alter table insurance_records add column if not exists subscriber_city text;
alter table insurance_records add column if not exists subscriber_state text;
alter table insurance_records add column if not exists subscriber_postal_code text;

-- Dependent-subscriber (policyholder) gender (Box 11a). Same vocabulary as
-- clients.gender; CHECK added separately + guarded so re-running is a no-op
-- (ADD CONSTRAINT has no IF NOT EXISTS). Allows NULL (unset).
alter table insurance_records add column if not exists subscriber_gender text;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'insurance_records_subscriber_gender_check'
  ) then
    alter table insurance_records
      add constraint insurance_records_subscriber_gender_check
      check (subscriber_gender is null or subscriber_gender in ('female', 'male', 'unknown'));
  end if;
end $$;
