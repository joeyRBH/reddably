'use strict';

// INBOUND Google Calendar -> calendar_events ingestion + name matching. Every
// new row lands with the column-default match_state 'unmatched'; after the
// upsert pass, still-unmatched rows are run through lib/calendar_match against
// the practice's active clients and a single unambiguous hit is staged as
// match_state 'matched' — a SUGGESTION only. Promotion to a sessions row
// happens exclusively on explicit human confirmation (handlers/calendar_events).
//
// Deliberately simple (one-practice pilot): a fixed now-30d .. now+60d window
// on every run, no sync tokens, no caching, no scheduling, no retry framework.
//
// Credentials: the OAuth refresh token lives in SSM at
//   /claimsub/prod/google/refresh/{calendar_connections.id}
// (written by handlers/calendar_oauth.js — the path is derived from the row id;
// no column stores it). A short-lived access token is re-minted from it on
// every sync and never persisted.
//
// PHI: event titles land in calendar_events.summary_raw verbatim. summary_raw
// is PHI — it is NEVER logged, and never appears in last_sync_error.

const db = require('./db');
const ssm = require('./ssm');
const google = require('./google_oauth');
const { matchEvent } = require('./calendar_match');

// Must mirror handlers/calendar_oauth.js (REFRESH_SSM_PREFIX) — both derive the
// parameter path from the connection row id.
const REFRESH_SSM_PREFIX =
  process.env.GOOGLE_REFRESH_SSM_PREFIX || '/claimsub/prod/google/refresh';

function refreshParamPath(connectionId) {
  return `${REFRESH_SSM_PREFIX}/${connectionId}`;
}

// Fixed ingestion window: far enough back to catch late-entered appointments,
// far enough forward to stage upcoming ones.
const WINDOW_PAST_DAYS = 30;
const WINDOW_FUTURE_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

// --- time helpers ---------------------------------------------------------------

// Offset (ms) of an IANA time zone at a given UTC instant, via Intl. Positive
// when the zone is ahead of UTC. Throws on an unknown zone (caller falls back).
function tzOffsetMs(instantMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(new Date(instantMs))) parts[p.type] = p.value;
  const wallAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );
  return wallAsUtc - instantMs;
}

// Midnight of an all-day event's 'YYYY-MM-DD' in the calendar's own time zone,
// as a UTC Date. The calendar_time_zone captured at connect is authoritative
// for deriving a local session date from an event timestamp (see the
// calendar_connections column comment); missing/invalid zone → UTC midnight.
function zonedMidnightUtc(dateStr, timeZone) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const utcGuess = Date.UTC(y, m - 1, d, 0, 0, 0);
  if (!timeZone) return new Date(utcGuess);
  try {
    let offset = tzOffsetMs(utcGuess, timeZone);
    // Re-check at the adjusted instant so a DST boundary at midnight resolves.
    const offset2 = tzOffsetMs(utcGuess - offset, timeZone);
    if (offset2 !== offset) offset = offset2;
    return new Date(utcGuess - offset);
  } catch (_) {
    return new Date(utcGuess);
  }
}

// --- event mapping + upsert -----------------------------------------------------

function mappedStatus(item) {
  const s = item && item.status;
  return s === 'tentative' || s === 'cancelled' ? s : 'confirmed';
}

// Upsert one Google event resource into calendar_events for a connection.
// Returns { op: 'inserted' | 'updated' | 'none', cancelled: boolean }.
async function upsertEvent(conn, item) {
  if (!item || !item.id) return { op: 'none', cancelled: false };
  const eventStatus = mappedStatus(item);
  const start = item.start || {};

  // With showDeleted=true, a cancellation can arrive as a bare tombstone
  // ({ id, status: 'cancelled' } — no start/end/summary). starts_at is NOT NULL,
  // so a tombstone can only mark an existing row cancelled; one we never staged
  // is skipped. Rows are NEVER deleted — they are an audit trail and may already
  // point at a promoted session.
  if (!start.dateTime && !start.date) {
    if (eventStatus !== 'cancelled') return { op: 'none', cancelled: false };
    const res = await db.query(
      `update calendar_events
          set event_status  = 'cancelled',
              external_etag = coalesce($3, external_etag),
              last_seen_at  = now()
        where connection_id = $1 and external_event_id = $2`,
      [conn.id, item.id, item.etag || null]
    );
    return { op: res.rowCount > 0 ? 'updated' : 'none', cancelled: res.rowCount > 0 };
  }

  const isAllDay = !start.dateTime;
  const startsAt = isAllDay
    ? zonedMidnightUtc(start.date, conn.calendar_time_zone)
    : new Date(start.dateTime);
  const end = item.end || {};
  const endsAt = !isAllDay && end.dateTime ? new Date(end.dateTime) : null;
  const durationMinutes =
    endsAt && !isAllDay ? Math.round((endsAt - startsAt) / 60000) : null;

  // The upsert updates ONLY what Google owns: external_etag, external_ical_uid,
  // external_recurring_event_id, summary_raw, starts_at, ends_at,
  // duration_minutes, is_all_day, event_status, last_seen_at.
  // It must NEVER touch match_state, matched_client_id, match_confidence,
  // match_reason, session_id, promoted_at, or first_seen_at — a human's
  // matching decision must survive every later sync. New rows take the column
  // defaults: match_state 'unmatched', first_seen_at now().
  const res = await db.query(
    `insert into calendar_events
       (practice_id, connection_id, clinician_id, external_event_id,
        external_ical_uid, external_recurring_event_id, external_etag,
        summary_raw, starts_at, ends_at, duration_minutes, is_all_day,
        event_status, last_seen_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
     on conflict (connection_id, external_event_id) do update
       set external_etag               = excluded.external_etag,
           external_ical_uid           = excluded.external_ical_uid,
           external_recurring_event_id = excluded.external_recurring_event_id,
           summary_raw                 = excluded.summary_raw,
           starts_at                   = excluded.starts_at,
           ends_at                     = excluded.ends_at,
           duration_minutes            = excluded.duration_minutes,
           is_all_day                  = excluded.is_all_day,
           event_status                = excluded.event_status,
           last_seen_at                = now()
     returning (xmax = 0) as is_new`,
    [
      conn.practice_id,
      conn.id,
      conn.user_id,
      item.id,
      item.iCalUID || null,
      item.recurringEventId || null,
      item.etag || null,
      item.summary || null,
      startsAt,
      endsAt,
      durationMinutes,
      isAllDay,
      eventStatus,
    ]
  );
  return {
    op: res.rows[0] && res.rows[0].is_new ? 'inserted' : 'updated',
    cancelled: eventStatus === 'cancelled',
  };
}

// --- name matching ----------------------------------------------------------------

// Run the matcher over this connection's rows still in match_state 'unmatched'
// (cancelled events skipped), against the practice's active clients. A single
// unambiguous hit stages the row as 'matched'; an ambiguous title records
// match_reason 'ambiguous' and stays 'unmatched'. Every UPDATE re-checks
// match_state = 'unmatched' in its WHERE so a row a human meanwhile confirmed
// or ignored is never overwritten. summary_raw is PHI and never leaves the
// query results — nothing here logs it, and match_reason only ever names a
// format ('full_name', ..., 'ambiguous').
async function matchUnmatchedEvents(conn) {
  const pending = await db.query(
    `select id, summary_raw from calendar_events
      where connection_id = $1
        and match_state = 'unmatched'
        and event_status <> 'cancelled'`,
    [conn.id]
  );
  if (pending.rowCount === 0) return;

  const candidates = await db.query(
    `select id, first_name, last_name, preferred_name from clients
      where practice_id = $1 and is_hidden = false and status <> 'inactive'`,
    [conn.practice_id]
  );
  if (candidates.rowCount === 0) return;

  for (const row of pending.rows) {
    const hit = matchEvent(row.summary_raw, candidates.rows);
    if (!hit) continue;
    if (hit.clientId) {
      await db.query(
        `update calendar_events
            set match_state = 'matched',
                matched_client_id = $2,
                match_confidence = $3,
                match_reason = $4
          where id = $1 and match_state = 'unmatched'`,
        [row.id, hit.clientId, hit.confidence, hit.reason]
      );
    } else {
      // Ambiguous: >1 candidate at the top tier. Record why, resolve nothing.
      await db.query(
        `update calendar_events
            set match_reason = 'ambiguous'
          where id = $1 and match_state = 'unmatched'`,
        [row.id]
      );
    }
  }
}

// --- error classification --------------------------------------------------------

// invalid_grant (revoked/expired refresh token) or a 401 from the events API:
// the connection needs the clinician to reconnect.
function isAuthRevoked(err) {
  if (!err) return false;
  return err.status === 401 || err.oauthErrorCode === 'invalid_grant';
}

// --- sync -------------------------------------------------------------------------

// syncConnection(connectionId) -> { inserted, updated, cancelled }.
//   * skips (all-zero counts) unless the connection's status is 'active';
//   * on revoked auth: marks the connection needs_reauth with a short non-PHI
//     last_sync_error and returns (no throw) — the connection row and its SSM
//     parameter are kept, so the clinician just reconnects via /start;
//   * on any other error: records last_sync_error and rethrows.
async function syncConnection(connectionId) {
  const loaded = await db.query(
    `select id, practice_id, user_id, calendar_id, calendar_time_zone, status
       from calendar_connections
      where id = $1`,
    [connectionId]
  );
  const conn = loaded.rows[0];
  if (!conn || conn.status !== 'active') {
    return { inserted: 0, updated: 0, cancelled: 0 };
  }

  const counts = { inserted: 0, updated: 0, cancelled: 0 };
  try {
    const refreshToken = await ssm.getParameter(refreshParamPath(conn.id));
    const accessToken = await google.refreshAccessToken(refreshToken);

    const now = Date.now();
    const items = await google.listEvents(accessToken, conn.calendar_id, {
      timeMin: new Date(now - WINDOW_PAST_DAYS * DAY_MS).toISOString(),
      timeMax: new Date(now + WINDOW_FUTURE_DAYS * DAY_MS).toISOString(),
    });

    for (const item of items) {
      const r = await upsertEvent(conn, item);
      if (r.op === 'inserted') counts.inserted += 1;
      else if (r.op === 'updated') counts.updated += 1;
      if (r.cancelled) counts.cancelled += 1;
    }

    await matchUnmatchedEvents(conn);

    await db.query(
      `update calendar_connections
          set last_synced_at = now(), last_sync_error = null
        where id = $1`,
      [conn.id]
    );
  } catch (err) {
    if (isAuthRevoked(err)) {
      // Keep the row and the SSM parameter — the clinician reconnects via the
      // existing /start flow, which overwrites both in place.
      await db.query(
        `update calendar_connections
            set status = 'needs_reauth', last_sync_error = $2
          where id = $1`,
        [conn.id, 'Calendar authorization expired — reconnect required.']
      );
      return counts;
    }
    // Operator-facing breadcrumb; lib error messages carry an HTTP status only,
    // never response bodies or event contents (no PHI).
    const message = String((err && err.message) || 'sync failed').slice(0, 300);
    await db
      .query(
        `update calendar_connections set last_sync_error = $2 where id = $1`,
        [conn.id, message]
      )
      .catch(() => {});
    throw err;
  }

  return counts;
}

module.exports = { syncConnection, refreshParamPath };
