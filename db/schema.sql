-- =============================================================================
-- Reddably — PostgreSQL schema (source of truth)
-- =============================================================================
-- Out-of-network (OON) insurance billing for mental-health group practices.
--
-- Conventions (see CLAUDE.md):
--   * UUID primary keys via gen_random_uuid() (pgcrypto).
--   * timestamptz created_at / updated_at, with a shared set_updated_at() trigger.
--   * text + CHECK constraints instead of native ENUM types.
--   * Soft-delete over hard-delete (is_active / is_hidden).
--   * Foreign keys default to ON DELETE RESTRICT to protect financial / PHI records.
--   * practice_id carried on every practice-scoped table (query scoping + future RLS).
--   * Money as numeric(12,2); percentages as numeric(5,2).
--
-- This file is intended to be applied to RDS separately. It is written to be
-- re-runnable where practical (create ... if not exists, create or replace).
-- =============================================================================

create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- Shared trigger function: keep updated_at current on every UPDATE.
-- -----------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =============================================================================
-- 1. subscription_plans — catalog of billing tiers (global, not practice-scoped).
-- =============================================================================
create table if not exists subscription_plans (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  name          text not null,
  description   text,
  price_cents   integer not null default 0,
  interval      text check (interval in ('month', 'year')),
  features      jsonb not null default '{}'::jsonb,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table subscription_plans is 'Catalog of subscription billing tiers offered to practices.';

create index if not exists idx_subscription_plans_is_active on subscription_plans (is_active);

drop trigger if exists trg_subscription_plans_updated_at on subscription_plans;
create trigger trg_subscription_plans_updated_at
  before update on subscription_plans
  for each row execute function set_updated_at();

-- =============================================================================
-- 2. practices — the group organization (top-level tenant).
-- =============================================================================
create table if not exists practices (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  slug                 text not null unique,
  npi                  text,
  tax_id               text,                                  -- PHI-adjacent
  address_line1        text,
  address_line2        text,
  city                 text,
  state                text,
  postal_code          text,
  country              text not null default 'US',
  default_fee_payer    text not null default 'client' check (default_fee_payer in ('client', 'practice')),
  platform_fee_percent numeric(5,2) not null default 5.00,
  plan                 varchar(20) not null default 'free',   -- 'free' | 'vob' | 'founder' (see practices_plan_check below)
  vob_checks_used      integer not null default 0,            -- Instant VOB usage counter (analytics)
  vob_period_start     date,                                  -- start of the current VOB add-on billing period
  stripe_account_id    text,                                  -- Stripe Connect account
  stripe_customer_id   text,
  stripe_subscription_id text,                                -- Stripe subscription for the VOB add-on
  notification_email   text,                                  -- optional override recipient for admin notifications (else the practice_admin's email)
  phone                text,                                  -- practice contact phone (ERA enrollment provider/primary contact)
  stedi_provider_id    text,                                  -- clearinghouse enrollment "provider" handle (one per practice TIN); minted lazily on first ERA enrollment
  npi_verified         boolean not null default false,        -- practice's OWN (organizational, Type-2) NPI verified against NPPES
  npi_verified_at      timestamptz,
  npi_enumeration_type text check (npi_enumeration_type in ('NPI-1', 'NPI-2')),  -- NPPES enumeration type of practices.npi (should be NPI-2 to bill as an org)
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
comment on table practices is 'Top-level tenant: the group mental-health practice that owns users, clients, and claims.';

create index if not exists idx_practices_slug on practices (slug);
create index if not exists idx_practices_is_active on practices (is_active);

drop trigger if exists trg_practices_updated_at on practices;
create trigger trg_practices_updated_at
  before update on practices
  for each row execute function set_updated_at();

-- Migration (idempotent): ensure the per-claim platform fee percent exists on the
-- live practices table (already declared above for fresh databases; this keeps a
-- pre-existing database in sync). See db/migrations/003_add_patient_billing_to_clients.sql.
alter table practices add column if not exists platform_fee_percent numeric(5,2) not null default 5.00;

-- Migration (idempotent): subscription plan flag + Instant VOB usage tracking +
-- Stripe subscription handle. Powers the $25/month Instant VOB add-on and the
-- permanent founder plan. See db/migrations/004_add_vob_plan_to_practices.sql.
alter table practices add column if not exists plan varchar(20) not null default 'free';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'practices_plan_check') then
    alter table practices add constraint practices_plan_check
      check (plan in ('free', 'vob', 'founder'));
  end if;
end $$;
alter table practices add column if not exists vob_checks_used integer not null default 0;
alter table practices add column if not exists vob_period_start date;
alter table practices add column if not exists stripe_subscription_id text;

-- Migration (idempotent): ensure the billing address exists on the live practices
-- table. Stedi's 837P submission requires a complete Billing.address block
-- (address1 / city / state / postalCode); a practice with no address makes Stedi
-- reject the claim. Declared above for fresh databases; these keep a pre-existing
-- database in sync. See db/migrations/006_add_billing_address_to_practices.sql.
alter table practices add column if not exists address_line1 text;
alter table practices add column if not exists address_line2 text;
alter table practices add column if not exists city text;
alter table practices add column if not exists state text;
alter table practices add column if not exists postal_code text;
alter table practices add column if not exists country text not null default 'US';

-- Migration (idempotent): optional notification recipient for admin emails (e.g.
-- the "client completed intake" alert). When null, notifications fall back to the
-- practice's first active practice_admin email. Declared above for fresh
-- databases; this keeps a pre-existing database in sync. See
-- db/migrations/009_add_notification_email_to_practices.sql.
alter table practices add column if not exists notification_email text;

-- Migration (idempotent): practice contact phone + the clearinghouse ERA-enrollment
-- provider handle. `phone` feeds the provider/primary contact on the enrollments
-- API; `stedi_provider_id` is minted once per practice TIN (NPI + tax id) the first
-- time the practice enrolls with any payer and reused for every subsequent payer.
-- Declared above for fresh databases; these keep a pre-existing database in sync.
-- See db/migrations/013_add_payer_enrollments.sql.
alter table practices add column if not exists phone text;
alter table practices add column if not exists stedi_provider_id text;

-- Migration (idempotent): practice organizational-NPI (Type-2) verification
-- result. Lets a practice billing as an organization confirm its own NPI is
-- really NPI-2 (a Type-1 individual NPI billed as an organization is what got
-- claims rejected with 277CA A3/26/1P "entity not found — provider"). Declared
-- above for fresh databases; these keep a pre-existing database in sync. See
-- db/migrations/014_add_provider_billing_profiles.sql.
alter table practices add column if not exists npi_verified boolean not null default false;
alter table practices add column if not exists npi_verified_at timestamptz;
alter table practices add column if not exists npi_enumeration_type text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'practices_npi_enum_type_check') then
    alter table practices add constraint practices_npi_enum_type_check
      check (npi_enumeration_type is null or npi_enumeration_type in ('NPI-1', 'NPI-2'));
  end if;
end $$;

-- =============================================================================
-- 3. practice_subscriptions — a practice's current plan.
-- =============================================================================
create table if not exists practice_subscriptions (
  id                      uuid primary key default gen_random_uuid(),
  practice_id             uuid not null references practices (id) on delete restrict,
  subscription_plan_id    uuid not null references subscription_plans (id) on delete restrict,
  stripe_subscription_id  text,
  status                  text not null check (status in ('active', 'trialing', 'past_due', 'canceled')),
  current_period_end      timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
comment on table practice_subscriptions is 'Links a practice to its current subscription plan and Stripe subscription state.';

create index if not exists idx_practice_subscriptions_practice_id on practice_subscriptions (practice_id);
create index if not exists idx_practice_subscriptions_plan_id on practice_subscriptions (subscription_plan_id);
create index if not exists idx_practice_subscriptions_status on practice_subscriptions (status);

drop trigger if exists trg_practice_subscriptions_updated_at on practice_subscriptions;
create trigger trg_practice_subscriptions_updated_at
  before update on practice_subscriptions
  for each row execute function set_updated_at();

-- =============================================================================
-- 4. users — clinicians and admins within a practice.
-- =============================================================================
create table if not exists users (
  id                 uuid primary key default gen_random_uuid(),
  practice_id        uuid not null references practices (id) on delete restrict,
  role               text not null check (role in ('practice_admin', 'clinician', 'billing_staff')),
  first_name         text not null,
  last_name          text not null,
  email              text not null unique,
  password_hash      text,                                    -- null when using OAuth only
  google_oauth_sub   text,
  title              text,
  npi                text,
  license_state      text,
  fee_payer_override text check (fee_payer_override in ('client', 'practice')),  -- null = inherit practice default
  is_active          boolean not null default true,
  last_login_at      timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
comment on table users is 'Staff accounts (practice admins, clinicians, billing staff) belonging to a practice.';

create index if not exists idx_users_practice_id on users (practice_id);
create index if not exists idx_users_email on users (email);
create index if not exists idx_users_role on users (role);
create index if not exists idx_users_is_active on users (is_active);

drop trigger if exists trg_users_updated_at on users;
create trigger trg_users_updated_at
  before update on users
  for each row execute function set_updated_at();

-- Migration (idempotent): per-clinician calendar feed token — an opaque, unique,
-- 32-byte (64 hex) capability backing the read-only ICS feed at
-- GET /calendar/{feed_token}.ics. See db/migrations/011_*. Backfill existing rows
-- and default new rows via pgcrypto's gen_random_bytes (extension enabled above).
alter table users add column if not exists calendar_feed_token text;
update users
   set calendar_feed_token = encode(gen_random_bytes(32), 'hex')
 where calendar_feed_token is null;
alter table users
  alter column calendar_feed_token set default encode(gen_random_bytes(32), 'hex');
create unique index if not exists idx_users_calendar_feed_token
  on users (calendar_feed_token);

-- =============================================================================
-- 5. clients — people receiving care (PHI-heavy).
-- =============================================================================
create table if not exists clients (
  id                   uuid primary key default gen_random_uuid(),
  practice_id          uuid not null references practices (id) on delete restrict,
  primary_clinician_id uuid references users (id) on delete restrict,
  first_name           text not null,
  last_name            text not null,
  preferred_name       text,
  pronouns             text,
  email                text,
  phone                text,
  date_of_birth        date,
  gender               text check (gender in ('female', 'male', 'unknown')),  -- 837 subscriber demographics (PHI)
  address_line1        text,                                  -- PHI; required by clearinghouses when patient is subscriber
  address_line2        text,
  city                 text,
  state                text,
  postal_code          text,
  country              text not null default 'US',
  diagnosis_codes      text[],                                -- default ICD-10 dx (dotless, billable) auto-applied to new sessions
  status               text not null default 'awaiting_info'
                         check (status in ('active', 'awaiting_info', 'inactive')),  -- 'active' == ready for claim submission
  is_hidden            boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
comment on table clients is 'People receiving care (PHI). Each has one primary clinician but can be reassigned.';

create index if not exists idx_clients_practice_id on clients (practice_id);
create index if not exists idx_clients_primary_clinician_id on clients (primary_clinician_id);
create index if not exists idx_clients_status on clients (status);
create index if not exists idx_clients_is_hidden on clients (is_hidden);

drop trigger if exists trg_clients_updated_at on clients;
create trigger trg_clients_updated_at
  before update on clients
  for each row execute function set_updated_at();

-- Migration (idempotent): add subscriber demographics + address to the live clients
-- table. Clearinghouses (Stedi) require the subscriber's gender and address when the
-- patient is the subscriber (837P SBR-02 = 18 / self).
alter table clients add column if not exists gender text;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'clients_gender_check'
  ) then
    alter table clients add constraint clients_gender_check
      check (gender in ('female', 'male', 'unknown'));
  end if;
end $$;
alter table clients add column if not exists address_line1 text;
alter table clients add column if not exists address_line2 text;
alter table clients add column if not exists city text;
alter table clients add column if not exists state text;
alter table clients add column if not exists postal_code text;
alter table clients add column if not exists country text not null default 'US';

-- Migration (idempotent): add patient billing (Stripe payment method) to the live
-- clients table. Reddably charges the patient a per-claim platform fee; staff send
-- an SMS link to a card-capture page that saves a Stripe PaymentMethod here. The
-- card-summary columns are display-only — never store a raw PAN/CVC (PCI). See
-- db/migrations/003_add_patient_billing_to_clients.sql.
alter table clients add column if not exists stripe_customer_id text;
alter table clients add column if not exists payment_method_id text;
alter table clients add column if not exists payment_method_brand text;
alter table clients add column if not exists payment_method_last4 text;
alter table clients add column if not exists payment_method_exp_month integer;
alter table clients add column if not exists payment_method_exp_year integer;
alter table clients add column if not exists payment_method_set_at timestamptz;
alter table clients add column if not exists payment_link_sent_at timestamptz;

-- Migration (idempotent): add default diagnosis codes to the live clients table.
-- New sessions (and the claims derived from them) auto-populate their ICD-10
-- diagnosis from here; the session form still allows a per-session override.
-- Stored dotless (F3290), billable-specificity only. See
-- db/migrations/008_add_diagnosis_codes_to_clients.sql.
alter table clients add column if not exists diagnosis_codes text[];

-- Migration (idempotent): retire the unused 'ready' client status. The allowed
-- set is now exactly active / awaiting_info / inactive, where 'active' already
-- means "ready for claim submission" — 'ready' was a synonym nothing ever set.
-- The patient intake flow does NOT set this status: it writes the patient's
-- answers to the chart and leaves them 'awaiting_info'. A clinician confirms on
-- the client chart ("Save as default"), which is an ordinary authenticated
-- PATCH /clients/{id}. Intake briefly auto-promoted to 'active' on its own; that
-- made a self-reported form the thing that decided who was billable, and it was
-- removed (backend/handlers/card_setup.js).
--
-- Order matters: any surviving row must be moved OFF 'ready' BEFORE the CHECK is
-- recreated, or the ALTER ... ADD CONSTRAINT fails validating those rows. They go
-- to 'awaiting_info', not 'active' — conservatively, since 'active' is what makes a
-- client billable and no one should become billable as a side effect of a migration.
-- Staff can promote them by hand from the client chart.
-- See db/migrations/015_remove_ready_client_status.sql.
update clients set status = 'awaiting_info' where status = 'ready';
do $$
begin
  -- Drop the old constraint only when it is actually the stale one (its definition
  -- still admits 'ready'), so a re-run against an already-migrated database is a
  -- no-op rather than a needless drop/recreate.
  if exists (
    select 1 from pg_constraint
     where conrelid = 'clients'::regclass
       and conname = 'clients_status_check'
       and pg_get_constraintdef(oid) like '%ready%'
  ) then
    alter table clients drop constraint clients_status_check;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'clients'::regclass
       and conname = 'clients_status_check'
  ) then
    alter table clients add constraint clients_status_check
      check (status in ('active', 'awaiting_info', 'inactive'));
  end if;
end $$;

-- =============================================================================
-- 6. insurance_records — OON benefit data per client (PHI).
-- =============================================================================
create table if not exists insurance_records (
  id                       uuid primary key default gen_random_uuid(),
  practice_id              uuid not null references practices (id) on delete restrict,
  client_id                uuid not null references clients (id) on delete restrict,
  carrier_name             text,
  member_id                text,                              -- PHI
  group_number             text,
  plan_type                text,
  subscriber_relationship  text,
  subscriber_name          text,
  subscriber_dob           date,
  subscriber_address_line1 text,                              -- policyholder address (PHI); dependent claims only (CMS-1500 Box 7)
  subscriber_address_line2 text,
  subscriber_city          text,
  subscriber_state         text,
  subscriber_postal_code   text,
  subscriber_gender        text                               -- policyholder gender (CMS-1500 Box 11a); same vocabulary as clients.gender
                             check (subscriber_gender is null or subscriber_gender in ('female', 'male', 'unknown')),
  oon_deductible_total     numeric(12,2),
  oon_deductible_met       numeric(12,2),
  oon_reimbursement_rate   numeric(5,2),
  payer_id                 varchar(50),                         -- clearinghouse trading-partner / payer id
  benefits_checked_at      timestamptz,
  benefits_raw             jsonb,
  is_primary               boolean not null default true,
  is_hidden                boolean not null default false,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
comment on table insurance_records is 'Out-of-network insurance benefit data for a client (PHI).';

create index if not exists idx_insurance_records_practice_id on insurance_records (practice_id);
create index if not exists idx_insurance_records_client_id on insurance_records (client_id);
create index if not exists idx_insurance_records_is_primary on insurance_records (is_primary);

drop trigger if exists trg_insurance_records_updated_at on insurance_records;
create trigger trg_insurance_records_updated_at
  before update on insurance_records
  for each row execute function set_updated_at();

-- Migration (idempotent): add PHI soft-delete to the live insurance_records table.
alter table insurance_records add column if not exists is_hidden boolean not null default false;
create index if not exists idx_insurance_records_is_hidden on insurance_records (is_hidden);

-- Migration (idempotent): add clearinghouse payer id to the live insurance_records table.
alter table insurance_records add column if not exists payer_id varchar(50);

-- Migration (idempotent): add the DEPENDENT-subscriber (policyholder) address +
-- gender to the live insurance_records table. Required by some payers when the
-- patient is a dependent on someone else's policy (837P subscriber loop; CMS-1500
-- Box 7 / 11a). Optional — the Stedi adapter omits them from the built body when
-- unset. See db/migrations/019_add_subscriber_demographics_prior_auth.sql.
alter table insurance_records add column if not exists subscriber_address_line1 text;
alter table insurance_records add column if not exists subscriber_address_line2 text;
alter table insurance_records add column if not exists subscriber_city text;
alter table insurance_records add column if not exists subscriber_state text;
alter table insurance_records add column if not exists subscriber_postal_code text;
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

-- =============================================================================
-- 7. sessions — therapy sessions (exist only to attach claims to).
-- =============================================================================
create table if not exists sessions (
  id               uuid primary key default gen_random_uuid(),
  practice_id      uuid not null references practices (id) on delete restrict,
  client_id        uuid not null references clients (id) on delete restrict,
  clinician_id     uuid not null references users (id) on delete restrict,
  session_date     date not null,
  duration_minutes integer,
  cpt_code         text,
  diagnosis_codes  text[],                                    -- ICD-10 codes
  place_of_service text,
  procedure_modifiers text[],                                 -- CMS-1500 Box 24D (e.g. 95 = synchronous telehealth)
  fee              numeric(12,2),
  notes            text,                                      -- billing notes only — no clinical notes
  status           text not null default 'scheduled'
                     check (status in ('scheduled', 'completed', 'claim_ready',
                                       'claim_submitted', 'awaiting_payment', 'paid', 'no_claim')),
  recurrence_group_id uuid,                                   -- links sessions pre-generated by one recurring request
  source           text not null default 'manual'
                     check (source in ('manual', 'calendar')),  -- provenance only; nothing reads it yet
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on table sessions is 'Therapy sessions that exist solely to attach claims to (no clinical notes).';

create index if not exists idx_sessions_practice_id on sessions (practice_id);
create index if not exists idx_sessions_client_id on sessions (client_id);
create index if not exists idx_sessions_clinician_id on sessions (clinician_id);
create index if not exists idx_sessions_status on sessions (status);
create index if not exists idx_sessions_session_date on sessions (session_date);

drop trigger if exists trg_sessions_updated_at on sessions;
create trigger trg_sessions_updated_at
  before update on sessions
  for each row execute function set_updated_at();

-- Migration (idempotent): add soft-delete to the live sessions table.
alter table sessions add column if not exists is_hidden boolean not null default false;
create index if not exists idx_sessions_is_hidden on sessions (is_hidden);

-- Migration (idempotent): add recurrence grouping to the live sessions table.
-- Sessions pre-generated by one recurring POST /sessions share a group id.
-- See db/migrations/005_add_recurrence_group_to_sessions.sql.
alter table sessions add column if not exists recurrence_group_id uuid;
create index if not exists idx_sessions_recurrence_group_id on sessions (recurrence_group_id);

-- Migration (idempotent): add procedure modifiers to the live sessions table.
-- Payer-required CMS-1500 Box 24D modifiers on the service line (e.g. 95 for
-- synchronous telehealth). See db/migrations/017_add_procedure_modifiers_to_sessions.sql.
alter table sessions add column if not exists procedure_modifiers text[];

-- Migration (idempotent): add session provenance to the live sessions table —
-- 'manual' (staff-created) | 'calendar' (promoted from a staged calendar_events
-- row, §19). Existing rows keep 'manual' (the column default makes the backfill
-- a no-op); nothing reads it yet. CHECK added separately + guarded so re-running
-- is a no-op (ADD CONSTRAINT has no IF NOT EXISTS). See
-- db/migrations/020_add_calendar_sync_tables.sql.
alter table sessions add column if not exists source text not null default 'manual';
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sessions_source_check'
  ) then
    alter table sessions add constraint sessions_source_check
      check (source in ('manual', 'calendar'));
  end if;
end $$;

-- =============================================================================
-- 8. claims — OON claim records (multiple allowed per session for resubmit/appeal).
-- =============================================================================
create table if not exists claims (
  id                     uuid primary key default gen_random_uuid(),
  practice_id            uuid not null references practices (id) on delete restrict,
  session_id             uuid not null references sessions (id) on delete restrict,
  client_id              uuid not null references clients (id) on delete restrict,
  clinician_id           uuid not null references users (id) on delete restrict,
  insurance_record_id    uuid references insurance_records (id) on delete restrict,
  claim_number           text,
  control_number         text,
  patient_control_number varchar(20),                         -- 837P CLM01 (<=20 chars); echoed in 277CA/835 for matching
  submission_frequency_code text                              -- frequency actually submitted: '1' original / '7' replacement (NULL until submitted)
                           check (submission_frequency_code is null or submission_frequency_code in ('1', '7')),
  payer_claim_control_number text,                            -- replacement (freq 7): payer's ORIGINAL claim number → 837P claim-level REF*F8
  corrects_claim_id      uuid references claims (id) on delete restrict,  -- self-ref: the claim this one replaces
  prior_authorization_number text,                            -- CMS-1500 Box 23 / 837P claim-level REF*G1; claim-level, NOT on the policy
  clearinghouse          text,                                -- e.g. office_ally
  status                 text not null default 'draft'
                           check (status in ('draft', 'submitted', 'processing', 'info_requested',
                                             'denied', 'appealed', 'paid', 'void')),
  billed_amount          numeric(12,2),
  allowed_amount         numeric(12,2),
  reimbursed_amount      numeric(12,2),
  patient_responsibility numeric(12,2),
  denial_reason          text,
  submitted_at           timestamptz,
  clearinghouse_payload  jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
comment on table claims is 'Out-of-network claim records; multiple claims may attach to one session (resubmission / appeal).';

create index if not exists idx_claims_practice_id on claims (practice_id);
create index if not exists idx_claims_session_id on claims (session_id);
create index if not exists idx_claims_client_id on claims (client_id);
create index if not exists idx_claims_clinician_id on claims (clinician_id);
create index if not exists idx_claims_insurance_record_id on claims (insurance_record_id);
create index if not exists idx_claims_status on claims (status);
create index if not exists idx_claims_submitted_at on claims (submitted_at);

drop trigger if exists trg_claims_updated_at on claims;
create trigger trg_claims_updated_at
  before update on claims
  for each row execute function set_updated_at();

-- Migration (idempotent): add soft-delete to the live claims table.
alter table claims add column if not exists is_hidden boolean not null default false;
create index if not exists idx_claims_is_hidden on claims (is_hidden);

-- Migration (idempotent): add the 837P patient control number (CLM01, <=20 chars).
-- Stedi rejects a >20-char value (error 33), so the adapter no longer sends the
-- 36-char UUID; a short per-claim control number is minted and stored here so it
-- stays stable across resubmissions and matches 277CA/835 responses back to the
-- claim. See db/migrations/007_add_patient_control_number_to_claims.sql.
alter table claims add column if not exists patient_control_number varchar(20);
create unique index if not exists idx_claims_patient_control_number
  on claims (patient_control_number)
  where patient_control_number is not null;

-- Migration (idempotent): replacement-claim (CMS frequency 7) durable submission
-- intent — the frequency actually submitted, the payer's original claim number
-- being replaced (→ 837P claim-level REF*F8), and a self-reference to the claim
-- being replaced. Frequency 7 ONLY; void (8) is a separate later change. See
-- db/migrations/018_add_replacement_claim_fields_to_claims.sql.
alter table claims add column if not exists submission_frequency_code text;
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

-- Migration (idempotent): add the claim-level prior authorization number to the
-- live claims table (CMS-1500 Box 23 / 837P claim-level REF*G1). Captured per
-- claim in the submit flow and copied into the immutable submission context;
-- deliberately NOT on insurance_records, since an authorization is specific to a
-- course of treatment and would otherwise leak onto unrelated claims. See
-- db/migrations/019_add_subscriber_demographics_prior_auth.sql.
alter table claims add column if not exists prior_authorization_number text;

-- =============================================================================
-- 9. claim_events — status-history log per claim.
--    Events belong to the claim's lifecycle, so ON DELETE CASCADE.
-- =============================================================================
create table if not exists claim_events (
  id           uuid primary key default gen_random_uuid(),
  practice_id  uuid not null references practices (id) on delete restrict,
  claim_id     uuid not null references claims (id) on delete cascade,
  created_by   uuid references users (id) on delete restrict,
  event_type   text not null check (event_type in ('created', 'submitted', 'accepted', 'processing',
                                                    'info_requested', 'denied', 'paid', 'appealed',
                                                    'voided', 'note')),
  status_from  text,
  status_to    text,
  note         text,
  payload      jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
comment on table claim_events is 'Append-style status-history log for a claim''s lifecycle (cascades with its claim).';

create index if not exists idx_claim_events_practice_id on claim_events (practice_id);
create index if not exists idx_claim_events_claim_id on claim_events (claim_id);
create index if not exists idx_claim_events_created_by on claim_events (created_by);
create index if not exists idx_claim_events_event_type on claim_events (event_type);

drop trigger if exists trg_claim_events_updated_at on claim_events;
create trigger trg_claim_events_updated_at
  before update on claim_events
  for each row execute function set_updated_at();

-- =============================================================================
-- 10. transactions — fee / billing records (5% per-claim fee, subscriptions, refunds, payouts).
-- =============================================================================
create table if not exists transactions (
  id                        uuid primary key default gen_random_uuid(),
  practice_id               uuid not null references practices (id) on delete restrict,
  client_id                 uuid references clients (id) on delete restrict,
  claim_id                  uuid references claims (id) on delete restrict,
  type                      text not null check (type in ('platform_fee', 'subscription', 'refund', 'payout', 'adjustment')),
  description               text,
  amount                    numeric(12,2) not null,
  currency                  text not null default 'usd',
  fee_payer                 text check (fee_payer in ('client', 'practice')),
  stripe_payment_intent_id  text,
  stripe_charge_id          text,
  stripe_refund_id          text,
  status                    text not null default 'pending'
                              check (status in ('pending', 'paid', 'failed', 'refunded', 'canceled')),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
comment on table transactions is 'Money movements: platform fees, subscriptions, refunds, payouts, and adjustments.';

create index if not exists idx_transactions_practice_id on transactions (practice_id);
create index if not exists idx_transactions_client_id on transactions (client_id);
create index if not exists idx_transactions_claim_id on transactions (claim_id);
create index if not exists idx_transactions_type on transactions (type);
create index if not exists idx_transactions_status on transactions (status);

drop trigger if exists trg_transactions_updated_at on transactions;
create trigger trg_transactions_updated_at
  before update on transactions
  for each row execute function set_updated_at();

-- =============================================================================
-- 10a. claim_acknowledgments — verbatim 277CA / claim-status payloads per claim.
-- =============================================================================
-- Every acknowledgment we receive from the clearinghouse for a claim, stored
-- WHOLE and UNTOUCHED: the synchronous submission response (277CA — the payer's
-- front-door accept/reject) and any later real-time claim-status (276/277)
-- response from a staff refresh. This is a passive dataset only — we STORE it,
-- we do NOT act on it (v1 does no automated denial detection; the patient tells
-- us the outcome). It exists so a later version can learn to recognize denials
-- from real payloads. Append-only: no updated_at, no application UPDATE/DELETE
-- path; cascades with its claim like claim_events. The payload can carry PHI
-- (names, member ids), so it lives behind the same RDS at-rest encryption as
-- claims.clearinghouse_payload and is NEVER logged.
create table if not exists claim_acknowledgments (
  id             uuid primary key default gen_random_uuid(),
  practice_id    uuid not null references practices (id) on delete restrict,
  claim_id       uuid not null references claims (id) on delete cascade,
  source         text,                                      -- clearinghouse adapter name (e.g. 'stedi'); white-labeled before any display
  kind           text not null default 'submission'
                   check (kind in ('submission', 'status')),
  control_number text,                                      -- echoed control number for matching, when present
  payload        jsonb not null,                            -- the acknowledgment VERBATIM — store, don't act
  received_at    timestamptz not null default now(),
  created_at     timestamptz not null default now()
);
comment on table claim_acknowledgments is 'Verbatim clearinghouse acknowledgments (277CA / 276-277 status) per claim. Append-only passive dataset — stored, never acted on in v1.';

create index if not exists idx_claim_acknowledgments_practice_id on claim_acknowledgments (practice_id);
create index if not exists idx_claim_acknowledgments_claim_id on claim_acknowledgments (claim_id);
create index if not exists idx_claim_acknowledgments_kind on claim_acknowledgments (kind);

-- =============================================================================
-- 10b. refund_requests — patient-initiated "my claim was denied" refund of the fee.
-- =============================================================================
-- SC's guarantee: a successful reimbursement, or the patient's fee back. A claim
-- that is PAID or applied to the DEDUCTIBLE is a SUCCESS (no refund); only a
-- DENIAL refunds the 5% platform fee. In v1 there is no patient surface: the
-- patient reports the outcome (via their clinician), and a practice admin records
-- it here and decides. `outcome_label` captures the reported EOB outcome for all
-- three cases (it is the labeled dataset for later automation), while `status`
-- tracks the admin's disposition of the request. Approving a request issues a
-- Stripe refund of the platform fee only (see backend/handlers/refund_requests.js);
-- decisions are additionally recorded in the append-only audit_log. At most one
-- OPEN request may exist per claim (the partial unique index below).
create table if not exists refund_requests (
  id               uuid primary key default gen_random_uuid(),
  practice_id      uuid not null references practices (id) on delete restrict,
  claim_id         uuid not null references claims (id) on delete restrict,
  client_id        uuid not null references clients (id) on delete restrict,  -- the patient
  outcome_label    text not null check (outcome_label in ('paid', 'deductible', 'denied')),
  status           text not null default 'open'
                     check (status in ('open', 'approved', 'denied')),
  patient_note     text,                                    -- optional note captured with the request
  decision_reason  text,                                    -- admin's reason on approve/deny (kept out of audit_log — may name the patient)
  decided_by       uuid references users (id) on delete restrict,
  decided_at       timestamptz,
  stripe_refund_id text,                                    -- set once, on approval; the Stripe refund of the fee
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on table refund_requests is 'Patient-initiated refund of the 5% platform fee on a denied claim. Admin-adjudicated; only outcome_label=denied is refundable. One open request per claim.';

create index if not exists idx_refund_requests_practice_id on refund_requests (practice_id);
create index if not exists idx_refund_requests_claim_id on refund_requests (claim_id);
create index if not exists idx_refund_requests_client_id on refund_requests (client_id);
create index if not exists idx_refund_requests_status on refund_requests (status);

-- Enforce "one open request per claim" at the database level: a second open
-- request for the same claim is rejected regardless of app-level checks or races.
-- Terminal (approved/denied) rows are exempt, so a claim can be re-requested only
-- after the prior request is resolved.
create unique index if not exists idx_refund_requests_one_open_per_claim
  on refund_requests (claim_id)
  where status = 'open';

drop trigger if exists trg_refund_requests_updated_at on refund_requests;
create trigger trg_refund_requests_updated_at
  before update on refund_requests
  for each row execute function set_updated_at();

-- =============================================================================
-- 11. documents — practice policy + questionnaire templates.
-- =============================================================================
create table if not exists documents (
  id                  uuid primary key default gen_random_uuid(),
  practice_id         uuid not null references practices (id) on delete restrict,
  type                text not null check (type in ('practice_policy', 'informed_consent', 'credit_card_auth',
                                                     'intake_questionnaire', 'w9', 'custom')),
  title               text not null,
  body                text,
  file_url            text,
  requires_signature  boolean not null default false,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
comment on table documents is 'Practice-owned policy and questionnaire templates (consent forms, intake, W-9, etc.).';

create index if not exists idx_documents_practice_id on documents (practice_id);
create index if not exists idx_documents_type on documents (type);
create index if not exists idx_documents_is_active on documents (is_active);

drop trigger if exists trg_documents_updated_at on documents;
create trigger trg_documents_updated_at
  before update on documents
  for each row execute function set_updated_at();

-- =============================================================================
-- 12. document_signatures — e-signature records (legal).
-- =============================================================================
create table if not exists document_signatures (
  id            uuid primary key default gen_random_uuid(),
  practice_id   uuid not null references practices (id) on delete restrict,
  document_id   uuid not null references documents (id) on delete restrict,
  client_id     uuid not null references clients (id) on delete restrict,
  signed_at     timestamptz,
  signer_name   text,
  signature_ref text,
  ip_address    inet,
  status        text not null default 'pending'
                  check (status in ('pending', 'signed', 'declined', 'voided')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table document_signatures is 'Legal e-signature records linking a client to a signed practice document.';

create index if not exists idx_document_signatures_practice_id on document_signatures (practice_id);
create index if not exists idx_document_signatures_document_id on document_signatures (document_id);
create index if not exists idx_document_signatures_client_id on document_signatures (client_id);
create index if not exists idx_document_signatures_status on document_signatures (status);

drop trigger if exists trg_document_signatures_updated_at on document_signatures;
create trigger trg_document_signatures_updated_at
  before update on document_signatures
  for each row execute function set_updated_at();

-- =============================================================================
-- 13. questionnaire_responses — client intake responses.
-- =============================================================================
create table if not exists questionnaire_responses (
  id            uuid primary key default gen_random_uuid(),
  practice_id   uuid not null references practices (id) on delete restrict,
  document_id   uuid not null references documents (id) on delete restrict,
  client_id     uuid not null references clients (id) on delete restrict,
  responses     jsonb not null default '{}'::jsonb,
  submitted_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table questionnaire_responses is 'Client-submitted answers to a practice intake questionnaire (PHI).';

create index if not exists idx_questionnaire_responses_practice_id on questionnaire_responses (practice_id);
create index if not exists idx_questionnaire_responses_document_id on questionnaire_responses (document_id);
create index if not exists idx_questionnaire_responses_client_id on questionnaire_responses (client_id);

drop trigger if exists trg_questionnaire_responses_updated_at on questionnaire_responses;
create trigger trg_questionnaire_responses_updated_at
  before update on questionnaire_responses
  for each row execute function set_updated_at();

-- =============================================================================
-- 14. invitations — clinician invite tokens.
-- =============================================================================
create table if not exists invitations (
  id               uuid primary key default gen_random_uuid(),
  practice_id      uuid not null references practices (id) on delete restrict,
  invited_by       uuid references users (id) on delete restrict,
  email            text not null,
  role             text not null check (role in ('practice_admin', 'clinician', 'billing_staff')),
  token            text not null unique,
  status           text not null default 'pending'
                     check (status in ('pending', 'accepted', 'expired', 'revoked')),
  expires_at       timestamptz,
  accepted_at      timestamptz,
  accepted_user_id uuid references users (id) on delete restrict,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on table invitations is 'Tokenized invitations for new staff to join a practice.';

create index if not exists idx_invitations_practice_id on invitations (practice_id);
create index if not exists idx_invitations_invited_by on invitations (invited_by);
create index if not exists idx_invitations_accepted_user_id on invitations (accepted_user_id);
create index if not exists idx_invitations_token on invitations (token);
create index if not exists idx_invitations_status on invitations (status);
create index if not exists idx_invitations_email on invitations (email);

drop trigger if exists trg_invitations_updated_at on invitations;
create trigger trg_invitations_updated_at
  before update on invitations
  for each row execute function set_updated_at();

-- Migration (idempotent): optional display name captured at invite time, used only
-- to personalize the invitation email + pending list. Staff name, not PHI. See
-- db/migrations/012_*.
alter table invitations add column if not exists invited_name text;

-- =============================================================================
-- 15. shareable_links — custom slugs per practice.
-- =============================================================================
create table if not exists shareable_links (
  id                   uuid primary key default gen_random_uuid(),
  practice_id          uuid not null references practices (id) on delete restrict,
  target_clinician_id  uuid references users (id) on delete restrict,
  type                 text not null check (type in ('therapist_referral', 'benefits_check', 'client_invite')),
  slug                 text not null unique,
  is_active            boolean not null default true,
  click_count          integer not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
comment on table shareable_links is 'Custom public slugs per practice (referral, benefits-check, client invite links).';

create index if not exists idx_shareable_links_practice_id on shareable_links (practice_id);
create index if not exists idx_shareable_links_target_clinician_id on shareable_links (target_clinician_id);
create index if not exists idx_shareable_links_slug on shareable_links (slug);
create index if not exists idx_shareable_links_type on shareable_links (type);
create index if not exists idx_shareable_links_is_active on shareable_links (is_active);

drop trigger if exists trg_shareable_links_updated_at on shareable_links;
create trigger trg_shareable_links_updated_at
  before update on shareable_links
  for each row execute function set_updated_at();

-- =============================================================================
-- 16. payer_enrollments — per-practice ERA (electronic remittance) enrollments.
-- =============================================================================
-- One row per payer per transaction type the practice has enrolled for through
-- the clearinghouse enrollments API. Enrollment is per-practice (TIN-level), not
-- per-clinician: it is keyed only on practice_id + payer_id + transaction_type.
-- `stedi_enrollment_id` is the clearinghouse's enrollment handle (used to poll
-- status); `status` mirrors the clearinghouse lifecycle verbatim
-- (STEDI_ACTION_REQUIRED → PROVISIONING → LIVE, plus PROVIDER_ACTION_REQUIRED /
-- CANCELED), and `status_reason` carries the clearinghouse's manual-step
-- instructions when the payer needs something from the practice. No PHI: this is
-- practice/payer trading-partner data only.
create table if not exists payer_enrollments (
  id                       uuid primary key default gen_random_uuid(),
  practice_id              uuid not null references practices (id) on delete restrict,
  payer_id                 text not null,                       -- the payer id/alias we enrolled with
  payer_name               text,
  transaction_type         text not null default 'claimPayment',
  stedi_enrollment_id      text unique,                         -- clearinghouse enrollment handle (poll status by this)
  status                   text not null default 'requested',   -- mirrors the clearinghouse enrollment lifecycle
  status_reason            text,                                -- clearinghouse manual-step instructions (surfaced verbatim in the UI)
  requested_effective_date date,
  last_synced_at           timestamptz,                         -- last time status was refreshed from the clearinghouse
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (practice_id, payer_id, transaction_type)
);
comment on table payer_enrollments is 'Per-practice ERA (electronic remittance) enrollments with payers, one row per payer + transaction type. No PHI.';

create index if not exists idx_payer_enrollments_practice_id on payer_enrollments (practice_id);
create index if not exists idx_payer_enrollments_status on payer_enrollments (status);

drop trigger if exists trg_payer_enrollments_updated_at on payer_enrollments;
create trigger trg_payer_enrollments_updated_at
  before update on payer_enrollments
  for each row execute function set_updated_at();

-- =============================================================================
-- 17. provider_billing_profiles — per-clinician billing identity for the 837P.
-- =============================================================================
-- One row per (practice_id, provider_user_id). Records whether the provider
-- bills as an INDIVIDUAL (Type-1 / person) or under the practice ORGANIZATION
-- (Type-2 / non-person entity), plus the NPPES verification snapshot for their
-- individual (Type-1) NPI. This is the source of truth the 837P builder reads to
-- construct the billing- and rendering-provider loops — no hardcoded entity type.
--
--   * person             → billing provider = this individual (legal name +
--                          individual_npi + billing TIN); NO rendering provider.
--   * non_person_entity  → billing provider = the practice organization
--                          (practices.name / practices.npi / practices.tax_id);
--                          rendering provider = this individual (individual_npi +
--                          legal name). rendering_provider_required = true.
--
-- The individual billing TIN (EIN or SSN) is app-layer AES-256-GCM ciphertext
-- (billing_tin_ciphertext) with a display-only masked last-4 (billing_tin_last4);
-- the raw value is never stored or returned. The organization EIN is NOT copied
-- here — it stays on practices.tax_id. No PHI in any column NAME.
create table if not exists provider_billing_profiles (
  id                          uuid primary key default gen_random_uuid(),
  practice_id                 uuid not null references practices (id) on delete restrict,
  provider_user_id            uuid not null references users (id) on delete restrict,
  billing_entity_type         text not null check (billing_entity_type in ('person', 'non_person_entity')),
  individual_npi              text,                            -- Type-1 (NPI-1): billing+rendering (person) or rendering (org)
  legal_first_name            text,
  legal_last_name             text,
  billing_tin_ciphertext      text,                            -- AES-256-GCM ciphertext of the person billing TIN (EIN/SSN); never the raw value
  billing_tin_last4           text,                            -- display-only masked last-4
  billing_tin_type            text check (billing_tin_type in ('EIN', 'SSN')),
  npi_verified                boolean not null default false,  -- individual_npi verified against NPPES
  npi_verified_at             timestamptz,
  npi_enumeration_type        text check (npi_enumeration_type in ('NPI-1', 'NPI-2')),
  sole_proprietor             boolean,
  primary_taxonomy_code       text,
  primary_taxonomy_desc       text,
  primary_taxonomy_license    text,
  primary_taxonomy_state      text,
  rendering_provider_required boolean not null default false,  -- true when billing as an organization
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (practice_id, provider_user_id)
);
comment on table provider_billing_profiles is 'Per-clinician billing identity (person vs organization) the 837P builder reads to construct the billing/rendering provider loops. Individual billing TIN is app-layer encrypted; no PHI in column names.';

create index if not exists idx_provider_billing_profiles_practice_id on provider_billing_profiles (practice_id);
create index if not exists idx_provider_billing_profiles_user_id on provider_billing_profiles (provider_user_id);

drop trigger if exists trg_provider_billing_profiles_updated_at on provider_billing_profiles;
create trigger trg_provider_billing_profiles_updated_at
  before update on provider_billing_profiles
  for each row execute function set_updated_at();

-- =============================================================================
-- 18. calendar_connections — inbound calendar sync: one authorized Google
--     calendar per clinician (OAuth + sync state; no PHI).
-- =============================================================================
-- INBOUND, read-only Google Calendar -> SC sync: a practice's EHR
-- (SimplePractice in the pilot) already syncs its appointments out to Google
-- Calendar, and SC reads that calendar to capture appointment facts without a
-- direct EHR API. Unrelated to the OUTBOUND de-identified ICS feed
-- (backend/handlers/calendar.js, users.calendar_feed_token, migration 011).
-- Holds the clinician's own account data and opaque sync handles — no PHI.
-- OAuth ACCESS tokens are deliberately not stored: they are short-lived and
-- re-minted from the refresh token on each sync. The refresh token is stored
-- only as KMS ciphertext — the plaintext is NEVER stored or logged.
create table if not exists calendar_connections (
  id                       uuid primary key default gen_random_uuid(),
  practice_id              uuid not null references practices (id) on delete restrict,
  user_id                  uuid not null references users (id) on delete restrict,
  provider                 text not null default 'google' check (provider in ('google')),
  account_email            text,                                -- the Google account that granted access
  calendar_id              text not null,                       -- Google calendar id (often the account email)
  calendar_time_zone       text,                                -- IANA zone from the calendar's own timeZone field, captured at connect; authoritative for deriving a local session date from an event timestamp
  refresh_token_ciphertext text,                                -- KMS-encrypted refresh token; the plaintext is NEVER stored or logged
  token_encryption_key_id  text,                                -- KMS key id/arn used for the ciphertext
  sync_token               text,                                -- Google nextSyncToken (incremental sync)
  channel_id               text,                                -- push-notification channel
  channel_resource_id      text,
  channel_expires_at       timestamptz,
  status                   text not null default 'active'
                             check (status in ('active', 'needs_reauth', 'disconnected')),
  last_synced_at           timestamptz,
  last_sync_error          text,                                -- operator-facing; never PHI
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (user_id, calendar_id)
);
comment on table calendar_connections is 'Inbound calendar sync: one authorized Google calendar per clinician (OAuth + sync state). No PHI. Access tokens are never stored — only the KMS-encrypted refresh token.';
comment on column calendar_connections.refresh_token_ciphertext is 'KMS-encrypted OAuth refresh token. The plaintext is never stored or logged; short-lived access tokens are re-minted from it on each sync and never persisted.';

create index if not exists idx_calendar_connections_practice_id on calendar_connections (practice_id);
create index if not exists idx_calendar_connections_status on calendar_connections (status);

drop trigger if exists trg_calendar_connections_updated_at on calendar_connections;
create trigger trg_calendar_connections_updated_at
  before update on calendar_connections
  for each row execute function set_updated_at();

-- =============================================================================
-- 19. calendar_events — staged inbound events + match state (PHI).
-- =============================================================================
-- One row per Google event per connection. Staging + match state ONLY: a
-- sessions row is what becomes a claim and what triggers the 5% platform fee,
-- so a fuzzy display-name match must never create one automatically. A row is
-- promoted to a sessions row only on explicit human confirmation (a later
-- change); reschedules, cancellations, and re-matches reconcile here in the
-- meantime. Treat as PHI: summary_raw carries the client display name,
-- de-identified or not.
create table if not exists calendar_events (
  id                          uuid primary key default gen_random_uuid(),
  practice_id                 uuid not null references practices (id) on delete restrict,
  connection_id               uuid not null references calendar_connections (id) on delete restrict,
  clinician_id                uuid not null references users (id) on delete restrict,
  external_event_id           text not null,                    -- Google event id (idempotency key)
  external_ical_uid           text,                             -- iCalUID; stable across moves
  external_recurring_event_id text,                             -- parent id for a recurrence instance
  external_etag               text,                             -- cheap change detection
  summary_raw                 text,                             -- event title verbatim (PHI)
  starts_at                   timestamptz not null,
  ends_at                     timestamptz,
  duration_minutes            integer,
  is_all_day                  boolean not null default false,
  event_status                text not null default 'confirmed'
                                check (event_status in ('confirmed', 'tentative', 'cancelled')),
  match_state                 text not null default 'unmatched'
                                check (match_state in ('unmatched', 'matched', 'confirmed', 'ignored')),
  matched_client_id           uuid references clients (id) on delete restrict,
  match_confidence            numeric(5,2),                     -- 0.00–100.00
  match_reason                text,                             -- which name format / rule matched; no PHI
  session_id                  uuid references sessions (id) on delete restrict,
  promoted_at                 timestamptz,
  first_seen_at               timestamptz not null default now(),
  last_seen_at                timestamptz not null default now(),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (connection_id, external_event_id)
);
comment on table calendar_events is 'Inbound Google Calendar events staged for review (PHI). A row is promoted to a sessions row only on explicit human confirmation — a name match never creates a billable session automatically.';
comment on column calendar_events.summary_raw is 'Event title verbatim from Google — carries the client display name, de-identified or not. PHI; never logged.';
comment on column calendar_events.matched_client_id is 'Candidate client from name matching (PHI linkage). A match alone never creates a session; promotion requires explicit confirmation.';

create index if not exists idx_calendar_events_practice_id on calendar_events (practice_id);
create index if not exists idx_calendar_events_clinician_starts on calendar_events (clinician_id, starts_at);
create index if not exists idx_calendar_events_unmatched on calendar_events (practice_id, starts_at) where match_state = 'unmatched';
create index if not exists idx_calendar_events_matched_client on calendar_events (matched_client_id);
create index if not exists idx_calendar_events_session_id on calendar_events (session_id);

drop trigger if exists trg_calendar_events_updated_at on calendar_events;
create trigger trg_calendar_events_updated_at
  before update on calendar_events
  for each row execute function set_updated_at();

-- =============================================================================
-- audit_log — append-only HIPAA compliance trail (no updated_at, no trigger).
-- =============================================================================
-- HIPAA 45 CFR 164.312(b) requires recording and examining activity in systems
-- containing ePHI. This table records WHO did WHAT to WHICH resource WHEN, using
-- ids and field NAMES only. It MUST NOT contain PHI — never a patient name, DOB,
-- member id, or diagnosis code in any column or in metadata. The application has
-- NO UPDATE or DELETE code path for this table (append-only by convention); the
-- read endpoint (backend/handlers/audit.js) is GET-only. Retain rows for at least
-- 6 years (HIPAA retention). See backend/lib/audit.js for the write helper.
create table if not exists audit_log (
  id             uuid primary key default gen_random_uuid(),
  occurred_at    timestamptz not null default now(),
  practice_id    uuid references practices (id) on delete restrict,  -- nullable: pre-auth events (login failure) have none
  actor_user_id  uuid references users (id) on delete restrict,      -- nullable: patient-link / system actors have no user
  actor_type     text not null check (actor_type in ('user', 'patient_link', 'system')),
  action         text not null,                                      -- dot notation, e.g. 'client.view', 'claim.submit'
  resource_type  text,                                               -- 'client' | 'insurance_record' | 'session' | 'claim' | 'vob' | 'user' | 'practice' | 'invitation' | 'auth' | 'payer_enrollment' | 'refund_request'
  resource_id    uuid,
  ip_address     text,                                               -- API GW requestContext.http.sourceIp
  user_agent     text,
  request_id     text,                                               -- Lambda/API GW request id (CloudWatch correlation)
  metadata       jsonb                                               -- NON-PHI only: e.g. {"fields_changed":["date_of_birth"]}, {"count":25}
);
comment on table audit_log is 'Append-only HIPAA audit trail (45 CFR 164.312(b)). WHO/WHAT/WHICH/WHEN by id and field name only — NEVER PHI values. No app UPDATE/DELETE path; 6-year retention.';

-- Migration (idempotent): bring a pre-existing audit_log (the older
-- entity_type/entity_id/created_at/inet shape) into line with the HIPAA design
-- above. Declared in the CREATE for fresh databases; these keep an existing
-- database in sync. See db/migrations/010_add_hipaa_audit_log.sql.
alter table audit_log add column if not exists occurred_at   timestamptz not null default now();
alter table audit_log add column if not exists resource_type text;
alter table audit_log add column if not exists resource_id   uuid;
alter table audit_log add column if not exists request_id    text;

-- ip_address widened from inet to text (older column used inet). Guarded so it
-- only runs when the column is not already text (idempotent / re-runnable).
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_name = 'audit_log' and column_name = 'ip_address' and data_type <> 'text'
  ) then
    alter table audit_log alter column ip_address type text using ip_address::text;
  end if;
end $$;

-- actor_type: replace the older check (which allowed 'client') with the new set
-- ('user' | 'patient_link' | 'system'). Drop-then-add so it re-runs cleanly.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'audit_log_actor_type_check') then
    alter table audit_log drop constraint audit_log_actor_type_check;
  end if;
  alter table audit_log add constraint audit_log_actor_type_check
    check (actor_type in ('user', 'patient_link', 'system'));
end $$;

create index if not exists idx_audit_log_practice_occurred on audit_log (practice_id, occurred_at desc);
create index if not exists idx_audit_log_resource on audit_log (resource_type, resource_id);
create index if not exists idx_audit_log_actor_occurred on audit_log (actor_user_id, occurred_at desc);
create index if not exists idx_audit_log_action on audit_log (action);

-- =============================================================================
-- Post-migration data: designate founder accounts (permanent free full access).
-- =============================================================================
-- Runs here (after `users` exists) rather than in the practices section, since it
-- references `users`. Keyed by login email — the users table has no username
-- column. No-op when the account is absent (fresh database), so it is safe on
-- every idempotent apply. See db/migrations/004_add_vob_plan_to_practices.sql.
update practices set plan = 'founder'
 where id = (
   select practice_id from users
    where lower(email) = lower('joseph@riverstonebehavioral.com')
    limit 1
 )
   and plan <> 'founder';

-- =============================================================================
-- End of schema.
-- =============================================================================
