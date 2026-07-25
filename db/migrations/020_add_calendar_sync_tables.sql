-- =============================================================================
-- Inbound calendar sync (Google Calendar -> SC): connection + staged-event
-- tables, and session provenance.
-- =============================================================================
-- A practice's EHR (SimplePractice in the pilot) already syncs its appointments
-- out to Google Calendar; SC reads that calendar to capture appointment facts
-- (date, time, duration, clinician, de-identified client display name) without
-- a direct EHR API. This sync is INBOUND and read-only — unrelated to the
-- existing OUTBOUND de-identified ICS feed (backend/handlers/calendar.js,
-- users.calendar_feed_token, migration 011), which is untouched.
--
-- Calendar events do NOT write into sessions. A sessions row is what becomes a
-- claim and what triggers the 5% platform fee, so a fuzzy display-name match
-- must never create one automatically. Events land in calendar_events with a
-- match state and are promoted to a sessions row only on explicit human
-- confirmation (a later change); reschedules, cancellations, and re-matches
-- have somewhere to reconcile in the meantime.
--
-- This adds:
--   * calendar_connections — one row per authorized Google calendar per
--     clinician: OAuth + sync state. No PHI (the clinician's own account data
--     and opaque sync handles). OAuth ACCESS tokens are deliberately not
--     stored: they are short-lived and re-minted from the refresh token on
--     each sync. The refresh token is stored only as KMS ciphertext — the
--     plaintext is NEVER stored or logged.
--   * calendar_events — staging + match state, one row per Google event per
--     connection. Treat as PHI: summary_raw carries the client display name,
--     de-identified or not.
--   * sessions.source — provenance ('manual' | 'calendar'). Existing rows keep
--     'manual' (the column default makes the backfill a no-op); nothing reads
--     it yet.
--
-- Idempotent / re-runnable (create table if not exists, add column if not
-- exists, create index if not exists, guarded CHECK additions).
-- Mirrored in db/schema.sql (§18 calendar_connections, §19 calendar_events,
-- §7 sessions) — schema.sql is the only path to a fresh database.
-- NOT auto-applied on deploy: an operator runs it via the claimsub-prod-migrate
-- Lambda. See db/migrations/README.md.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- calendar_connections — one authorized Google calendar per clinician
-- (OAuth + sync state; no PHI).
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- calendar_events — staged inbound events + match state (PHI).
-- One row per Google event per connection; promoted to a sessions row only on
-- explicit human confirmation, never automatically.
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- sessions.source — provenance ('manual' | 'calendar'). Existing rows keep
-- 'manual' (the column default makes the backfill a no-op); nothing reads it
-- yet. CHECK added separately + guarded so re-running is a no-op (ADD
-- CONSTRAINT has no IF NOT EXISTS).
-- -----------------------------------------------------------------------------
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
