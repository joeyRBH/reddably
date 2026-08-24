'use strict';

// Unit tests — calendar-event promotion handler (backend/handlers/calendar_events.js).
//
// Covers:
//   * promoting creates ONE sessions row with the appointment facts only:
//     status 'scheduled', source 'calendar', diagnosis inherited from the
//     client, and cpt_code / place_of_service / fee / procedure_modifiers all
//     NULL (a calendar event carries no billing data);
//   * session_date derives from the connection's calendar_time_zone, not UTC —
//     a late-evening Denver appointment that is already "tomorrow" in UTC lands
//     on the Denver date;
//   * promoting twice returns the same session and creates no second row;
//   * a cancelled event cannot be promoted;
//   * a client from another practice is rejected;
//   * ignore flips match_state and is reversible via promote.
//
// No network, no real DB: lib/auth and lib/db (query + withTransaction) are
// stubbed. Tests run sequentially over shared in-memory tables.
//
//   node backend/tests/calendar_promote.test.js

const assert = require('node:assert');
const path = require('node:path');

const CALLER_ID = '11111111-1111-1111-1111-111111111111';
const PRACTICE_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_PRACTICE_ID = '99999999-9999-9999-9999-999999999999';
const CONN_ID = '33333333-3333-3333-3333-333333333333';
const CLINICIAN_ID = '44444444-4444-4444-4444-444444444444';
const CLIENT_ID = '55555555-5555-5555-5555-555555555555';
const OTHER_CLIENT_ID = '66666666-6666-6666-6666-666666666666';
const EVENT_ID = '77777777-7777-7777-7777-777777777777';

// --- stub lib/auth BEFORE requiring the handler -------------------------------

const authLib = require(path.join(__dirname, '..', 'lib', 'auth.js'));
authLib.requireAuth = () => ({ user: { sub: CALLER_ID, practice_id: PRACTICE_ID } });

// --- stub lib/db: in-memory tables --------------------------------------------

const dbLib = require(path.join(__dirname, '..', 'lib', 'db.js'));

const state = {
  connections: [],
  events: [],
  clients: [],
  sessions: [],
  auditRows: [],
};
let seq = 0;

async function stubQuery(text, params) {
  const t = String(text).replace(/\s+/g, ' ');

  if (/select practice_id from users where id = \$1/.test(t)) {
    return { rows: [{ practice_id: PRACTICE_ID }], rowCount: 1 };
  }

  // promote: event + connection zone, locked (FOR UPDATE)
  if (/from calendar_events e join calendar_connections cc/.test(t)) {
    const ev = state.events.find((r) => r.id === params[0] && r.practice_id === params[1]);
    if (!ev) return { rows: [], rowCount: 0 };
    const conn = state.connections.find((r) => r.id === ev.connection_id);
    return {
      rows: [{ ...ev, calendar_time_zone: conn ? conn.calendar_time_zone : null }],
      rowCount: 1,
    };
  }

  if (/select \* from sessions where id = \$1/.test(t)) {
    const row = state.sessions.find((r) => r.id === params[0] && r.practice_id === params[1]);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }

  // Promotion now selects the whole client row: the session is seeded from
  // that client's billing defaults, not just their diagnosis codes.
  if (/select \* from clients/.test(t)) {
    const row = state.clients.find(
      (r) => r.id === params[0] && r.practice_id === params[1] && !r.is_hidden
    );
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }

  if (/insert into sessions/.test(t)) {
    // Parse the column list from the SQL itself so a drifted INSERT (e.g. one
    // that started sending a cpt_code) fails here instead of silently passing.
    const cols = t
      .match(/insert into sessions \(([^)]+)\) values/i)[1]
      .split(',')
      .map((s) => s.trim());
    const row = {
      id: `session-${++seq}`,
      cpt_code: null,
      place_of_service: null,
      fee: null,
      procedure_modifiers: null,
      notes: null,
      created_at: new Date(),
    };
    const valueTokens = t
      .match(/values \(([^)]+)\) returning/i)[1]
      .split(',')
      .map((s) => s.trim());
    cols.forEach((c, i) => {
      const tok = valueTokens[i];
      if (/^\$\d+$/.test(tok)) row[c] = params[Number(tok.slice(1)) - 1];
      else row[c] = tok.replace(/^'(.*)'$/, '$1');
    });
    state.sessions.push(row);
    return { rows: [row], rowCount: 1 };
  }

  if (/update calendar_events set match_state = 'confirmed'/.test(t)) {
    const row = state.events.find((r) => r.id === params[0]);
    if (row) {
      row.match_state = 'confirmed';
      row.matched_client_id = params[1];
      row.session_id = params[2];
      row.promoted_at = new Date();
    }
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }

  // ignore
  if (/update calendar_events set match_state = 'ignored'/.test(t)) {
    const row = state.events.find(
      (r) => r.id === params[0] && r.practice_id === params[1] && r.match_state !== 'confirmed'
    );
    if (row) row.match_state = 'ignored';
    return { rows: row ? [{ id: row.id, match_state: row.match_state }] : [], rowCount: row ? 1 : 0 };
  }

  if (/select 1 from calendar_events where id = \$1/.test(t)) {
    const row = state.events.find((r) => r.id === params[0] && r.practice_id === params[1]);
    return { rows: row ? [{}] : [], rowCount: row ? 1 : 0 };
  }

  if (/insert into audit_log/.test(t)) {
    state.auditRows.push({ action: params[3], metadata: params[9] });
    return { rows: [], rowCount: 1 };
  }

  throw new Error(`stub: unexpected query: ${t.slice(0, 80)}`);
}

dbLib.query = stubQuery;
dbLib.withTransaction = async (fn) => fn({ query: stubQuery });

const handler = require(path.join(__dirname, '..', 'handlers', 'calendar_events.js')).handler;

// --- request helper -----------------------------------------------------------

function promoteRequest(eventId, clientId) {
  return {
    requestContext: {
      http: { method: 'POST', path: `/calendar-events/${eventId}/promote` },
      routeKey: 'POST /calendar-events/{id}/promote',
    },
    pathParameters: { id: eventId },
    body: JSON.stringify({ client_id: clientId }),
  };
}

function ignoreRequest(eventId) {
  return {
    requestContext: {
      http: { method: 'POST', path: `/calendar-events/${eventId}/ignore` },
      routeKey: 'POST /calendar-events/{id}/ignore',
    },
    pathParameters: { id: eventId },
    body: '{}',
  };
}

function reset() {
  state.connections = [
    { id: CONN_ID, practice_id: PRACTICE_ID, calendar_time_zone: 'America/Denver' },
  ];
  state.events = [
    {
      id: EVENT_ID,
      practice_id: PRACTICE_ID,
      connection_id: CONN_ID,
      clinician_id: CLINICIAN_ID,
      summary_raw: 'Sarah M',
      // 9:00 PM July 10 in Denver == 3:00 AM July 11 UTC: the UTC date is
      // already "tomorrow", so a UTC-derived session_date would be wrong.
      starts_at: new Date('2026-07-11T03:00:00Z'),
      ends_at: new Date('2026-07-11T03:50:00Z'),
      duration_minutes: 50,
      event_status: 'confirmed',
      match_state: 'matched',
      matched_client_id: CLIENT_ID,
      match_confidence: 90,
      match_reason: 'first_name_last_initial',
      session_id: null,
      promoted_at: null,
    },
  ];
  state.clients = [
    {
      id: CLIENT_ID,
      practice_id: PRACTICE_ID,
      is_hidden: false,
      diagnosis_codes: ['F411'],
    },
    { id: OTHER_CLIENT_ID, practice_id: OTHER_PRACTICE_ID, is_hidden: false, diagnosis_codes: null },
  ];
  state.sessions = [];
  state.auditRows = [];
}

// --- test 1: promotion creates the session with appointment facts only ----------

async function testPromoteCreatesSession() {
  reset();
  const res = await handler(promoteRequest(EVENT_ID, CLIENT_ID));
  assert.strictEqual(res.statusCode, 201, res.body);
  const body = JSON.parse(res.body);

  assert.strictEqual(state.sessions.length, 1, 'exactly one sessions row');
  const s = state.sessions[0];
  assert.strictEqual(s.practice_id, PRACTICE_ID);
  assert.strictEqual(s.client_id, CLIENT_ID);
  assert.strictEqual(s.clinician_id, CLINICIAN_ID, 'clinician from the event');
  assert.strictEqual(s.duration_minutes, 50);
  assert.strictEqual(s.status, 'scheduled');
  assert.strictEqual(s.source, 'calendar');
  assert.deepStrictEqual(s.diagnosis_codes, ['F411'], 'default dx inherited from the client');

  // Appointment facts only — never billing data.
  assert.strictEqual(s.cpt_code, null, 'cpt_code is null');
  assert.strictEqual(s.place_of_service, null, 'place_of_service is null');
  assert.strictEqual(s.fee, null, 'fee is null');
  assert.strictEqual(s.procedure_modifiers, null, 'procedure_modifiers is null');

  const ev = state.events[0];
  assert.strictEqual(ev.match_state, 'confirmed');
  assert.strictEqual(ev.session_id, s.id);
  assert.ok(ev.promoted_at, 'promoted_at set');

  assert.strictEqual(body.session.id, s.id);
  assert.ok(
    state.auditRows.some((r) => r.action === 'calendar_event.promote'),
    'promotion is audited'
  );
  console.log('PASS promotion creates a scheduled calendar-sourced session with null billing fields');
}

// --- test 2: session_date derives from the calendar time zone, not UTC ----------

async function testSessionDateUsesCalendarZone() {
  reset();
  await handler(promoteRequest(EVENT_ID, CLIENT_ID));
  const s = state.sessions[0];
  // 2026-07-11T03:00:00Z is 9:00 PM on July 10 in Denver.
  assert.strictEqual(s.session_date, '2026-07-10', 'Denver evening stays on the Denver date');
  assert.notStrictEqual(s.session_date, '2026-07-11', 'not the UTC date');
  console.log('PASS session_date derives from calendar_time_zone, not UTC');
}

// --- test 3: promotion is idempotent --------------------------------------------

async function testPromoteTwiceIsIdempotent() {
  reset();
  const first = await handler(promoteRequest(EVENT_ID, CLIENT_ID));
  assert.strictEqual(first.statusCode, 201);
  const firstBody = JSON.parse(first.body);

  const second = await handler(promoteRequest(EVENT_ID, CLIENT_ID));
  assert.strictEqual(second.statusCode, 200, 'replay is a 200, not a new create');
  const secondBody = JSON.parse(second.body);

  assert.strictEqual(secondBody.session.id, firstBody.session.id, 'same session returned');
  assert.strictEqual(secondBody.already_promoted, true);
  assert.strictEqual(state.sessions.length, 1, 'still exactly one sessions row');
  console.log('PASS promoting twice returns the same session and creates only one row');
}

// --- test 4: a cancelled event cannot be promoted --------------------------------

async function testCancelledEventRejected() {
  reset();
  state.events[0].event_status = 'cancelled';
  const res = await handler(promoteRequest(EVENT_ID, CLIENT_ID));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(state.sessions.length, 0, 'no session created');
  assert.strictEqual(state.events[0].match_state, 'matched', 'event untouched');
  console.log('PASS a cancelled event cannot be promoted');
}

// --- test 5: the client must belong to the caller's practice ---------------------

async function testForeignClientRejected() {
  reset();
  const res = await handler(promoteRequest(EVENT_ID, OTHER_CLIENT_ID));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(state.sessions.length, 0, 'no session created');
  assert.strictEqual(state.events[0].match_state, 'matched', 'event stays unconfirmed');
  console.log('PASS a client from another practice is rejected');
}

// --- test 6: ignore, and promote reverses it -------------------------------------

async function testIgnoreThenPromote() {
  reset();
  const ign = await handler(ignoreRequest(EVENT_ID));
  assert.strictEqual(ign.statusCode, 200);
  assert.strictEqual(state.events[0].match_state, 'ignored');
  assert.strictEqual(state.sessions.length, 0, 'ignore never creates a session');

  const res = await handler(promoteRequest(EVENT_ID, CLIENT_ID));
  assert.strictEqual(res.statusCode, 201, 'promote reverses an ignore');
  assert.strictEqual(state.events[0].match_state, 'confirmed');

  // A confirmed event can no longer be ignored.
  const again = await handler(ignoreRequest(EVENT_ID));
  assert.strictEqual(again.statusCode, 400);
  assert.strictEqual(state.events[0].match_state, 'confirmed');
  console.log('PASS ignore is reversible via promote; a confirmed event cannot be ignored');
}


// --- test 7: the promoted session is SEEDED from the client's billing defaults --
// The point of per-client defaults. Before them, promotion inserted a session
// with cpt_code / place_of_service / fee / procedure_modifiers all NULL, so the
// clinician could not "just verify the appointment" — every promoted session
// needed billing data typed in before it could become a submittable claim.
async function testPromoteSeedsBillingDefaults() {
  reset();
  const client = state.clients.find((c) => c.id === CLIENT_ID);
  client.default_cpt_code = '90837';
  client.default_place_of_service = '10';
  client.default_session_fee = '175.00';
  client.default_procedure_modifiers = ['95'];

  const res = await handler(promoteRequest(EVENT_ID, CLIENT_ID));
  assert.strictEqual(res.statusCode, 201, res.body);

  const s = state.sessions[0];
  assert.strictEqual(s.cpt_code, '90837', 'CPT is seeded');
  assert.strictEqual(s.place_of_service, '10', 'place of service is seeded');
  assert.strictEqual(s.fee, '175.00', 'fee is seeded');
  assert.deepStrictEqual(s.procedure_modifiers, ['95'], 'modifiers are seeded');
  assert.deepStrictEqual(s.diagnosis_codes, ['F411'],
    'diagnosis still carries over, as it always did');
  console.log('PASS a promoted session is seeded from the client billing defaults');
}

// --- test 8: a client with NO defaults promotes exactly as it used to -----------
// The seeding only ever fills a blank. A practice that never sets a default must
// see byte-identical behaviour to before the feature existed.
async function testPromoteWithoutDefaultsIsUnchanged() {
  reset();
  const res = await handler(promoteRequest(EVENT_ID, CLIENT_ID));
  assert.strictEqual(res.statusCode, 201, res.body);

  const s = state.sessions[0];
  assert.ok(s.cpt_code == null, 'no CPT');
  assert.ok(s.place_of_service == null, 'no place of service');
  assert.ok(s.fee == null, 'no fee');
  assert.ok(s.procedure_modifiers == null, 'no modifiers');
  assert.deepStrictEqual(s.diagnosis_codes, ['F411'],
    'diagnosis still carries over — that default predates the others');
  console.log('PASS a client with no defaults promotes exactly as before');
}

(async function main() {
  await testPromoteCreatesSession();
  await testSessionDateUsesCalendarZone();
  await testPromoteTwiceIsIdempotent();
  await testCancelledEventRejected();
  await testForeignClientRejected();
  await testIgnoreThenPromote();
  await testPromoteSeedsBillingDefaults();
  await testPromoteWithoutDefaultsIsUnchanged();
  console.log('PASS calendar_promote.test.js');
})().catch((err) => {
  console.error('FAIL calendar_promote.test.js');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
