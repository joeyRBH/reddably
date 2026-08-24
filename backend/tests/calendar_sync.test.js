'use strict';

// Unit tests — inbound calendar event ingestion
// (backend/lib/calendar_sync.js + the listEvents addition to
// backend/lib/google_oauth.js).
//
// Covers:
//   * a recurring series expands to one row per occurrence (real listEvents
//     over a stubbed fetch: singleEvents=true, showDeleted=true, pagination);
//   * re-syncing an event whose match_state is 'confirmed' updates starts_at
//     but leaves match_state, matched_client_id, and session_id untouched —
//     the DB stub applies the query's ACTUAL SET clause, so a widened upsert
//     that touched match columns would fail here;
//   * a cancelled event sets event_status 'cancelled' and does not delete the
//     row;
//   * invalid_grant sets the connection status 'needs_reauth' (row and SSM
//     parameter kept).
//
// No network, no real DB, no AWS: lib/ssm, lib/db, and (per test) either
// global.fetch or lib/google_oauth are stubbed. Tests run sequentially.
//
//   node backend/tests/calendar_sync.test.js

const assert = require('node:assert');
const path = require('node:path');

const CONN_ID = '33333333-3333-3333-3333-333333333333';
const PRACTICE_ID = '22222222-2222-2222-2222-222222222222';
const CLINICIAN_ID = '11111111-1111-1111-1111-111111111111';
const CLIENT_ID = '55555555-5555-5555-5555-555555555555';
const SESSION_ID = '66666666-6666-6666-6666-666666666666';

// --- stub lib/ssm BEFORE anything that requires it ----------------------------

const ssmLib = require(path.join(__dirname, '..', 'lib', 'ssm.js'));

let ssmDeleteCalls = [];
ssmLib.getParameter = async (name) => {
  if (name === `/claimsub/prod/google/refresh/${CONN_ID}`) return 'refresh-token-1';
  throw new Error(`SSM parameter ${name} is empty or missing`);
};
ssmLib.deleteParameter = async (name) => {
  ssmDeleteCalls.push(name);
};

// --- stub lib/db: in-memory connections + events -------------------------------
// The calendar_events upsert is applied by parsing the query's real column list
// and SET assignments, so the stub enforces exactly what the SQL says — no
// hand-mirrored semantics that could drift from the code under test.

const dbLib = require(path.join(__dirname, '..', 'lib', 'db.js'));

const state = { connections: [], events: [], clients: [] };
let seq = 0;

function applyEventUpsert(text, params) {
  const cols = text
    .match(/insert into calendar_events\s*\(([\s\S]+?)\)\s*values/i)[1]
    .split(',')
    .map((s) => s.trim());
  const valueTokens = text
    .match(/values\s*\(([\s\S]+?)\)\s*on conflict/i)[1]
    .split(',')
    .map((s) => s.trim());
  const incoming = {};
  cols.forEach((c, i) => {
    const tok = valueTokens[i];
    if (/^\$\d+$/.test(tok)) incoming[c] = params[Number(tok.slice(1)) - 1];
    else if (tok === 'now()') incoming[c] = new Date();
    else throw new Error(`stub: unexpected VALUES token "${tok}"`);
  });

  const existing = state.events.find(
    (r) =>
      r.connection_id === incoming.connection_id &&
      r.external_event_id === incoming.external_event_id
  );
  if (!existing) {
    state.events.push({
      id: `event-${++seq}`,
      // Column defaults the INSERT does not name:
      match_state: 'unmatched',
      matched_client_id: null,
      match_confidence: null,
      match_reason: null,
      session_id: null,
      promoted_at: null,
      first_seen_at: new Date(),
      ...incoming,
    });
    return { rows: [{ is_new: true }], rowCount: 1 };
  }

  // Apply ONLY the assignments the SQL's DO UPDATE SET clause names.
  const assignments = text
    .match(/do update\s+set\s+([\s\S]*?)\s+returning/i)[1]
    .split(',')
    .map((s) => s.trim());
  for (const a of assignments) {
    const m = a.match(/^(\w+)\s*=\s*([\s\S]+)$/);
    const col = m[1];
    const expr = m[2].trim();
    if (expr === `excluded.${col}`) existing[col] = incoming[col];
    else if (expr === 'now()') existing[col] = new Date();
    else throw new Error(`stub: unexpected SET expression "${a}"`);
  }
  return { rows: [{ is_new: false }], rowCount: 1 };
}

dbLib.query = async (text, params) => {
  const t = String(text);
  if (/from calendar_connections\s+where id = \$1/.test(t)) {
    const row = state.connections.find((r) => r.id === params[0]);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  if (/update calendar_connections\s+set last_synced_at = now\(\), last_sync_error = null/.test(t)) {
    const row = state.connections.find((r) => r.id === params[0]);
    if (row) {
      row.last_synced_at = new Date();
      row.last_sync_error = null;
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }
  if (/update calendar_connections\s+set status = 'needs_reauth', last_sync_error = \$2/.test(t)) {
    const row = state.connections.find((r) => r.id === params[0]);
    if (row) {
      row.status = 'needs_reauth';
      row.last_sync_error = params[1];
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }
  if (/update calendar_connections set last_sync_error = \$2/.test(t)) {
    const row = state.connections.find((r) => r.id === params[0]);
    if (row) row.last_sync_error = params[1];
    return { rows: [], rowCount: row ? 1 : 0 };
  }
  if (/insert into calendar_events/.test(t)) {
    return applyEventUpsert(t, params);
  }
  // Post-upsert matching pass (lib/calendar_match wiring). state.clients stays
  // empty in these tests, so no row is ever staged 'matched' here — matching
  // itself is covered by calendar_match.test.js.
  if (/select id, summary_raw from calendar_events/.test(t)) {
    const rows = state.events.filter(
      (r) =>
        r.connection_id === params[0] &&
        r.match_state === 'unmatched' &&
        r.event_status !== 'cancelled'
    );
    return { rows, rowCount: rows.length };
  }
  if (/select id, first_name, last_name, preferred_name, calendar_display_name from clients/.test(t)) {
    return { rows: state.clients, rowCount: state.clients.length };
  }
  if (/update calendar_events\s+set match_state = 'matched'/.test(t)) {
    const row = state.events.find((r) => r.id === params[0] && r.match_state === 'unmatched');
    if (row) {
      row.match_state = 'matched';
      row.matched_client_id = params[1];
      row.match_confidence = params[2];
      row.match_reason = params[3];
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }
  if (/update calendar_events\s+set match_reason = 'ambiguous'/.test(t)) {
    const row = state.events.find((r) => r.id === params[0] && r.match_state === 'unmatched');
    if (row) row.match_reason = 'ambiguous';
    return { rows: [], rowCount: row ? 1 : 0 };
  }
  if (/update calendar_events\s+set event_status\s+= 'cancelled'/.test(t)) {
    const row = state.events.find(
      (r) => r.connection_id === params[0] && r.external_event_id === params[1]
    );
    if (row) {
      row.event_status = 'cancelled';
      if (params[2] != null) row.external_etag = params[2];
      row.last_seen_at = new Date();
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }
  throw new Error(`stub: unexpected query: ${t.slice(0, 80)}`);
};

const googleLib = require(path.join(__dirname, '..', 'lib', 'google_oauth.js'));
const { syncConnection } = require(path.join(__dirname, '..', 'lib', 'calendar_sync.js'));

function resetConnection() {
  state.connections = [
    {
      id: CONN_ID,
      practice_id: PRACTICE_ID,
      user_id: CLINICIAN_ID,
      calendar_id: 'ada@example.com',
      calendar_time_zone: 'America/Denver',
      status: 'active',
      last_synced_at: null,
      last_sync_error: null,
    },
  ];
}

function occurrence(n, startIso, endIso) {
  return {
    id: `recur_2026070${n}T170000Z`,
    iCalUID: 'recur@google.com',
    recurringEventId: 'recur',
    etag: `"etag-${n}"`,
    status: 'confirmed',
    summary: 'Weekly — A.L.',
    start: { dateTime: startIso },
    end: { dateTime: endIso },
  };
}

// --- test 1: recurring series expands to one row per occurrence ------------------
// Real listEvents over a stubbed fetch: asserts singleEvents=true +
// showDeleted=true + the fixed window on the request, follows nextPageToken.

async function testRecurringExpansion() {
  resetConnection();
  state.events = [];
  googleLib.refreshAccessToken = async () => 'short-lived-at';

  const pages = [
    {
      items: [
        occurrence(1, '2026-07-01T17:00:00Z', '2026-07-01T17:50:00Z'),
        occurrence(8, '2026-07-08T17:00:00Z', '2026-07-08T17:50:00Z'),
      ],
      nextPageToken: 'page-2',
    },
    {
      items: [occurrence(15, '2026-07-15T17:00:00Z', '2026-07-15T17:50:00Z')],
    },
  ];
  const fetchedUrls = [];
  global.fetch = async (url) => {
    fetchedUrls.push(new URL(url));
    return { ok: true, status: 200, json: async () => pages[fetchedUrls.length - 1] };
  };

  const counts = await syncConnection(CONN_ID);

  assert.strictEqual(fetchedUrls.length, 2, 'nextPageToken followed until exhausted');
  const q1 = fetchedUrls[0].searchParams;
  assert.strictEqual(q1.get('singleEvents'), 'true', 'occurrences expanded, not the series');
  assert.strictEqual(q1.get('showDeleted'), 'true', 'cancellations arrive as tombstones');
  assert.ok(q1.get('timeMin') && q1.get('timeMax'), 'fixed window sent');
  assert.strictEqual(fetchedUrls[1].searchParams.get('pageToken'), 'page-2');

  assert.deepStrictEqual(counts, { inserted: 3, updated: 0, cancelled: 0 });
  assert.strictEqual(state.events.length, 3, 'one row per occurrence');
  for (const row of state.events) {
    assert.strictEqual(row.external_recurring_event_id, 'recur');
    assert.strictEqual(row.match_state, 'unmatched', 'ingestion never matches');
    assert.strictEqual(row.duration_minutes, 50);
    assert.strictEqual(row.practice_id, PRACTICE_ID);
    assert.strictEqual(row.clinician_id, CLINICIAN_ID);
  }
  const conn = state.connections[0];
  assert.ok(conn.last_synced_at, 'last_synced_at set');
  assert.strictEqual(conn.last_sync_error, null);

  console.log('PASS recurring series expands to one row per occurrence');
}

// --- test 2: re-sync leaves a human matching decision untouched ------------------

async function testResyncPreservesMatch() {
  // Simulate a human having confirmed the first occurrence.
  const row = state.events[0];
  row.match_state = 'confirmed';
  row.matched_client_id = CLIENT_ID;
  row.session_id = SESSION_ID;

  // The same event comes back rescheduled (new start, new etag).
  googleLib.listEvents = async () => [
    occurrence(1, '2026-07-02T18:00:00Z', '2026-07-02T18:50:00Z'),
  ];

  const counts = await syncConnection(CONN_ID);
  assert.deepStrictEqual(counts, { inserted: 0, updated: 1, cancelled: 0 });
  assert.strictEqual(state.events.length, 3, 'no duplicate row');
  assert.strictEqual(
    row.starts_at.toISOString(),
    '2026-07-02T18:00:00.000Z',
    'reschedule lands'
  );
  assert.strictEqual(row.external_etag, '"etag-1"');
  assert.strictEqual(row.match_state, 'confirmed', 'match_state survives re-sync');
  assert.strictEqual(row.matched_client_id, CLIENT_ID, 'matched_client_id survives');
  assert.strictEqual(row.session_id, SESSION_ID, 'session_id survives');

  console.log('PASS re-sync updates starts_at but never a matching decision');
}

// --- test 3: cancellation marks, never deletes ----------------------------------

async function testCancellationKeepsRow() {
  // A showDeleted tombstone: id + status only, no start/end/summary.
  googleLib.listEvents = async () => [
    { id: state.events[1].external_event_id, status: 'cancelled', etag: '"etag-x"' },
  ];

  const counts = await syncConnection(CONN_ID);
  assert.deepStrictEqual(counts, { inserted: 0, updated: 1, cancelled: 1 });
  assert.strictEqual(state.events.length, 3, 'row NOT deleted');
  assert.strictEqual(state.events[1].event_status, 'cancelled');

  console.log('PASS cancelled event sets event_status and keeps the row');
}

// --- test 4: invalid_grant -> needs_reauth --------------------------------------

async function testInvalidGrantNeedsReauth() {
  resetConnection();
  ssmDeleteCalls = [];
  googleLib.refreshAccessToken = async () => {
    const err = new Error('Google token refresh failed (HTTP 400)');
    err.status = 400;
    err.oauthErrorCode = 'invalid_grant';
    throw err;
  };

  const counts = await syncConnection(CONN_ID); // must resolve, not throw
  assert.deepStrictEqual(counts, { inserted: 0, updated: 0, cancelled: 0 });
  const conn = state.connections[0];
  assert.strictEqual(conn.status, 'needs_reauth');
  assert.ok(conn.last_sync_error, 'a short operator-facing error is recorded');
  assert.ok(!/google/i.test(conn.last_sync_error), 'error is vendor-free');
  assert.strictEqual(ssmDeleteCalls.length, 0, 'SSM parameter kept for reconnect');
  assert.strictEqual(state.connections.length, 1, 'connection row kept');

  console.log('PASS invalid_grant sets needs_reauth (row + parameter kept)');
}

(async function main() {
  await testRecurringExpansion();
  await testResyncPreservesMatch();
  await testCancellationKeepsRow();
  await testInvalidGrantNeedsReauth();
  console.log('PASS calendar_sync.test.js');
})().catch((err) => {
  console.error('FAIL calendar_sync.test.js');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
