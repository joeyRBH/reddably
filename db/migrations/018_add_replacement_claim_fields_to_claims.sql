-- =============================================================================
-- Replacement claims (CMS-1500 Box 22 / 837P CLM05-3 frequency 7): durable
-- submission intent on the claims table.
-- =============================================================================
-- A replacement claim tells the payer to REPLACE a claim it previously accepted,
-- rather than treating the resubmission as a brand-new original (frequency 1),
-- which payers reject as a duplicate. To send one, the 837P must carry the
-- payer's ORIGINAL claim control number (translated by the clearinghouse to the
-- claim-level REF*F8 segment). See backend/lib/clearinghouse/stedi.js and the
-- submit-handler safety gate in backend/handlers/claims.js.
--
-- These columns make the submission intent DURABLE — so we can later explain
-- exactly what was sent for any claim — instead of living only in transient
-- request input:
--
--   submission_frequency_code — the frequency actually submitted ('1' original /
--     '7' replacement). NULL for claims not yet submitted (and historical rows);
--     the submit handler writes it at submission time.
--   payer_claim_control_number — the payer's original claim number being replaced
--     (entered explicitly by an operator; NOT auto-parsed from the 277CA/835,
--     which are persisted verbatim in claim_acknowledgments but not mined in v1).
--   corrects_claim_id — self-reference to the claim this one replaces. ON DELETE
--     RESTRICT like every other financial FK (protect the lineage).
--
-- This is frequency 7 (replacement) ONLY. Void (frequency 8) has materially
-- different consequences and is a separate, later change — deliberately not here.
--
-- Idempotent / re-runnable (add column if not exists, guarded index + constraint).
-- Mirrored in db/schema.sql (§8) — schema.sql is the only path to prod.
-- NOT auto-applied on deploy: an operator runs it via the claimsub-prod-migrate
-- Lambda. See db/migrations/README.md.

alter table claims add column if not exists submission_frequency_code text;

-- CHECK added separately + guarded so re-running is a no-op (ADD CONSTRAINT has no
-- IF NOT EXISTS). Allows NULL (not-yet-submitted / historical) and the two codes
-- this capability supports; 8 (void) is intentionally excluded until that change.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'claims_submission_frequency_code_check'
  ) then
    alter table claims
      add constraint claims_submission_frequency_code_check
      check (submission_frequency_code is null or submission_frequency_code in ('1', '7'));
  end if;
end $$;

alter table claims add column if not exists payer_claim_control_number text;

alter table claims add column if not exists corrects_claim_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'claims_corrects_claim_id_fkey'
  ) then
    alter table claims
      add constraint claims_corrects_claim_id_fkey
      foreign key (corrects_claim_id) references claims (id) on delete restrict;
  end if;
end $$;

create index if not exists idx_claims_corrects_claim_id on claims (corrects_claim_id);
