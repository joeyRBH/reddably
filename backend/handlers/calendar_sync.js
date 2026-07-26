'use strict';

// INBOUND Google Calendar sync — on-demand event ingestion:
//
//   POST /integrations/google/sync — Bearer-JWT authed; syncs every ACTIVE
//   connection owned by the caller into calendar_events and returns the counts.
//
// Ingestion only (see lib/calendar_sync.js): no matching, no promotion to
// sessions, no schedule — the caller triggers it. One connection failing must
// not abort the others: each is synced in its own try/catch and reports either
// its counts or a vendor-free error entry.
//
// White-labeling: the route path says google (internal identifier); anything
// returned to the client says "calendar" / "your calendar provider".
//
// Security: event titles are PHI and are never logged or returned here — only
// counts leave this handler. Connection lookup is practice- AND user-scoped.

const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');
const { audit } = require('../lib/audit');
const { syncConnection } = require('../lib/calendar_sync');

function httpMethod(event) {
  if (!event) return '';
  if (event.httpMethod) return event.httpMethod;
  const ctx = event.requestContext;
  return (ctx && ctx.http && ctx.http.method) || '';
}

exports.handler = async (event) => {
  const method = httpMethod(event);
  if (method === 'OPTIONS') return preflight(event);
  if (method !== 'POST') return json(404, { error: 'Not found.' }, event);

  let user;
  try {
    ({ user } = requireAuth(event));
  } catch (err) {
    if (err && err.name === 'AuthError') {
      return json(err.statusCode || 401, { error: err.message }, event);
    }
    console.error('calendar_sync auth error:', (err && err.message) || 'unknown');
    return json(500, { error: 'Something went wrong syncing your calendar.' }, event);
  }

  try {
    const owned = await db.query(
      `select id from calendar_connections
        where practice_id = $1 and user_id = $2 and status = 'active'
        order by created_at`,
      [user.practice_id, user.sub]
    );

    const connections = [];
    const totals = { inserted: 0, updated: 0, cancelled: 0 };
    for (const row of owned.rows) {
      try {
        const counts = await syncConnection(row.id);
        totals.inserted += counts.inserted;
        totals.updated += counts.updated;
        totals.cancelled += counts.cancelled;
        connections.push({ id: row.id, ...counts });
      } catch (err) {
        // Terse marker only — the error message can name the vendor, and event
        // payloads (PHI) never reach this layer. The per-connection detail is
        // already recorded on the row's last_sync_error by lib/calendar_sync.
        console.error('calendar sync failed for connection', row.id);
        connections.push({
          id: row.id,
          error: 'Could not sync this calendar. Please try again.',
        });
      }
    }

    await audit(event, { userId: user.sub, practiceId: user.practice_id }, {
      action: 'calendar_events.sync',
      resourceType: 'calendar_connection',
      metadata: {
        connections: owned.rowCount,
        inserted: totals.inserted,
        updated: totals.updated,
        cancelled: totals.cancelled,
      },
    });

    return json(200, { connections, totals }, event);
  } catch (err) {
    // Generic 500 — never the underlying message (it could name the vendor).
    console.error('calendar_sync error:', (err && err.message) || 'unknown');
    return json(500, { error: 'Something went wrong syncing your calendar.' }, event);
  }
};
