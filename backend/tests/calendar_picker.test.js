'use strict';

// Unit tests — calendar picker (PATCH /integrations/google/connections/{id}
// in backend/handlers/calendar_oauth.js).
//
// Covers:
//   * a calendar_id NOT in the connected account's calendar list is rejected
//     (never trust the client's string) and nothing changes;
//   * a valid switch updates calendar_id AND calendar_time_zone together, the
//     zone coming from the chosen calendar's own timeZone;
//   * the switch deletes staged calendar_events with no session_id but KEEPS
//     rows already promoted to a session (audit trail);
//   * a target calendar already synced by ANOTHER of the user's connections is
//     rejected with a clear 409 — the (user_id, calendar_id) unique constraint
//     must never surface as a 500.
//
// No network, no real DB, no AWS: lib/ssm, lib/db, and lib/google_oauth are
// stubbed. Tests run sequentially (they share the stubs' state).
//
//   node backend/tests/calendar_picker.test.js

const assert = require('node:assert');
const path = require('node:path');

process.env.JWT_SECRET = 'test-secret';

// --- stub lib/ssm BEFORE anything that requires it ----------------------------

const ssmLib = require(path.join(__dirname, '..', 'lib', 'ssm.js'));
ssmLib.getParameter = async () => 'stub-refresh-token';
ssmLib.putParameter = async () => {};
ssmLib.deleteParameter = async () => {};

// --- stub lib/google_oauth ------------------------------------------------------

const googleLib = require(path.join(__dirname, '..', 'lib', 'google_oauth.js'));

const ACCOUNT_CALENDARS = [
  { id: 'ada@example.com', summary: 'Ada', timeZone: 'America/Denver', primary: true },
  { id: 'appts-cal-id', summary: 'Appointments', timeZone: 'America/Chicago', primary: false },
];

googleLib.refreshAccessToken = async () => 'short-lived-at';
googleLib.listCalendars = async () => ACCOUNT_CALENDARS.map((c) => ({ ...c }));

// --- stub lib/db: in-memory calendar_connections + calendar_events ---------------

const dbLib = require(path.join(__dirname, '..', 'lib', 'db.js'));

const CALLER_ID = '11111111-1111-1111-1111-111111111111';
const PRACTICE_ID = '22222222-2222-2222-2222-222222222222';
const CONN_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_CONN_ID = '44444444-4444-4444-4444-444444444444';

const state = { connections: [], events: [] };

function resetState() {
  state.connections = [
    {
      id: CONN_ID,
      practice_id: PRACTICE_ID,
      user_id: CALLER_ID,
      calendar_id: 'ada@example.com',
      calendar_time_zone: 'America/Denver',
      status: 'active',
      last_sync_error: 'old error',
    },
  ];
  state.events = [
    { id: 'ev-staged-1', connection_id: CONN_ID, session_id: null },
    { id: 'ev-staged-2', connection_id: CONN_ID, session_id: null },
    { id: 'ev-promoted', connection_id: CONN_ID, session_id: 'a-session-id' },
  ];
}

async function stubQuery(text, params) {
  const t = String(text);
  if (/select id, calendar_id, status from calendar_connections/.test(t)) {
    const [id, practiceId, userId] = params;
    const row = state.connections.find(
      (r) => r.id === id && r.practice_id === practiceId && r.user_id === userId
    );
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  if (/select 1 from calendar_connections/.test(t)) {
    const [userId, calendarId, notId] = params;
    const hit = state.connections.find(
      (r) => r.user_id === userId && r.calendar_id === calendarId && r.id !== notId
    );
    return { rows: hit ? [{ '?column?': 1 }] : [], rowCount: hit ? 1 : 0 };
  }
  if (/update calendar_connections\s+set calendar_id/.test(t)) {
    const [id, calendarId, timeZone] = params;
    const row = state.connections.find((r) => r.id === id);
    if (row) {
      row.calendar_id = calendarId;
      row.calendar_time_zone = timeZone;
      row.last_sync_error = null;
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }
  if (/delete from calendar_events/.test(t)) {
    const [connectionId] = params;
    const before = state.events.length;
    state.events = state.events.filter(
      (e) => !(e.connection_id === connectionId && e.session_id == null)
    );
    return { rows: [], rowCount: before - state.events.length };
  }
  if (/insert into audit_log/.test(t)) {
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

dbLib.query = stubQuery;
dbLib.withTransaction = async (fn) => fn({ query: stubQuery });

// --- handler + a real Bearer token ------------------------------------------------

const jwtLib = require(path.join(__dirname, '..', 'lib', 'jwt.js'));
const { handler } = require(path.join(__dirname, '..', 'handlers', 'calendar_oauth.js'));

const TOKEN = jwtLib.sign({ id: CALLER_ID, practice_id: PRACTICE_ID, role: 'clinician' });

function patchEvent(connectionId, calendarId) {
  return {
    requestContext: {
      http: { method: 'PATCH', path: `/integrations/google/connections/${connectionId}` },
      routeKey: 'PATCH /integrations/google/connections/{id}',
    },
    pathParameters: { id: connectionId },
    headers: { authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ calendar_id: calendarId }),
  };
}

// --- test 1: unknown calendar_id is rejected, nothing changes ---------------------

async function testRejectsUnknownCalendar() {
  resetState();
  const res = await handler(patchEvent(CONN_ID, 'not-a-real-calendar'));
  assert.strictEqual(res.statusCode, 400, 'a calendar not on the account is rejected');

  const conn = state.connections[0];
  assert.strictEqual(conn.calendar_id, 'ada@example.com', 'calendar_id unchanged');
  assert.strictEqual(conn.calendar_time_zone, 'America/Denver', 'time zone unchanged');
  assert.strictEqual(state.events.length, 3, 'no staged events were deleted');
  assert.ok(!/google/i.test(res.body), 'no vendor name in the client-facing error');
  console.log('PASS unknown calendar_id rejected (no state change)');
}

// --- test 2: switch updates calendar_id + calendar_time_zone together -------------

async function testSwitchUpdatesIdAndZone() {
  resetState();
  const res = await handler(patchEvent(CONN_ID, 'appts-cal-id'));
  assert.strictEqual(res.statusCode, 200);

  const conn = state.connections[0];
  assert.strictEqual(conn.calendar_id, 'appts-cal-id', 'calendar_id switched');
  assert.strictEqual(
    conn.calendar_time_zone,
    'America/Chicago',
    "time zone comes from the CHOSEN calendar's own timeZone"
  );
  assert.strictEqual(conn.last_sync_error, null, 'stale sync error cleared');

  const body = JSON.parse(res.body);
  assert.strictEqual(body.updated, true);
  assert.strictEqual(body.calendar_id, 'appts-cal-id');
  assert.strictEqual(body.calendar_time_zone, 'America/Chicago');
  console.log('PASS switch updates calendar_id and calendar_time_zone together');
}

// --- test 3: staged events cleared, promoted events kept --------------------------

async function testClearsStagedKeepsPromoted() {
  resetState();
  const res = await handler(patchEvent(CONN_ID, 'appts-cal-id'));
  assert.strictEqual(res.statusCode, 200);

  const remaining = state.events.map((e) => e.id);
  assert.deepStrictEqual(
    remaining,
    ['ev-promoted'],
    'unpromoted rows deleted; the promoted row (session_id set) is kept'
  );
  assert.strictEqual(JSON.parse(res.body).events_cleared, 2, 'cleared count reported');
  console.log('PASS staged events cleared, promoted events kept');
}

// --- test 4: target calendar already on another connection → clear 409 ------------

async function testRejectsDuplicateConnection() {
  resetState();
  state.connections.push({
    id: OTHER_CONN_ID,
    practice_id: PRACTICE_ID,
    user_id: CALLER_ID,
    calendar_id: 'appts-cal-id',
    calendar_time_zone: 'America/Chicago',
    status: 'active',
    last_sync_error: null,
  });

  const res = await handler(patchEvent(CONN_ID, 'appts-cal-id'));
  assert.strictEqual(res.statusCode, 409, 'clear conflict, not a constraint 500');

  const conn = state.connections.find((r) => r.id === CONN_ID);
  assert.strictEqual(conn.calendar_id, 'ada@example.com', 'calendar_id unchanged');
  assert.strictEqual(state.events.length, 3, 'no staged events were deleted');

  const body = JSON.parse(res.body);
  assert.ok(body.error, 'an error message is returned');
  assert.ok(!/google/i.test(res.body), 'no vendor name in the client-facing error');
  console.log('PASS duplicate target connection rejected with 409');
}

(async function main() {
  await testRejectsUnknownCalendar();
  await testSwitchUpdatesIdAndZone();
  await testClearsStagedKeepsPromoted();
  await testRejectsDuplicateConnection();
  console.log('PASS calendar_picker.test.js');
})().catch((err) => {
  console.error('FAIL calendar_picker.test.js');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
