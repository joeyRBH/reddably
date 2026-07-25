'use strict';

// Unit tests — Google Calendar OAuth connect flow
// (backend/lib/google_oauth.js + backend/handlers/calendar_oauth.js).
//
// Covers:
//   * the consent URL carries the readonly scope, offline access, and
//     prompt=consent (so a refresh token is actually returned);
//   * state round-trips; a tampered / wrong-purpose / wrong-secret state is
//     rejected;
//   * the callback conflict path ((user_id, calendar_id) already connected)
//     UPDATES the existing row and overwrites the SSM parameter at the SAME
//     row-id path — never a second row or a second parameter;
//   * the SSM-failure path deletes a freshly-inserted row (never an active row
//     whose parameter does not exist) and returns a vendor-free error.
//
// No network, no real DB, no AWS: lib/ssm, lib/db, and lib/google_oauth are
// stubbed. Tests run sequentially (they share the stubs' state).
//
//   node backend/tests/google_oauth.test.js

const assert = require('node:assert');
const path = require('node:path');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret';

// --- stub lib/ssm BEFORE anything that requires it ----------------------------

const ssmLib = require(path.join(__dirname, '..', 'lib', 'ssm.js'));

const SSM_PARAMS = {
  '/claimsub/prod/google/client_id': 'client-id-123',
  '/claimsub/prod/google/client_secret': 'client-secret-xyz',
};
let ssmPutCalls = [];
let ssmDeleteCalls = [];
let ssmPutFails = false;

ssmLib.getParameter = async (name) => {
  if (!SSM_PARAMS[name]) throw new Error(`SSM parameter ${name} is empty or missing`);
  return SSM_PARAMS[name];
};
ssmLib.putParameter = async (name, value) => {
  if (ssmPutFails) throw new Error('AccessDeniedException');
  ssmPutCalls.push({ name, value });
};
ssmLib.deleteParameter = async (name) => {
  ssmDeleteCalls.push({ name });
};

const google = require(path.join(__dirname, '..', 'lib', 'google_oauth.js'));

// --- test 1: consent URL shape -------------------------------------------------

async function testAuthUrl() {
  const url = await google.buildAuthUrl({ state: 'the-state' });
  const parsed = new URL(url);

  assert.strictEqual(parsed.origin + parsed.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.strictEqual(
    parsed.searchParams.get('scope'),
    'https://www.googleapis.com/auth/calendar.readonly',
    'readonly scope ONLY'
  );
  assert.strictEqual(parsed.searchParams.get('access_type'), 'offline', 'offline access requested');
  assert.strictEqual(parsed.searchParams.get('prompt'), 'consent', 'prompt=consent so a refresh token is returned');
  assert.strictEqual(parsed.searchParams.get('response_type'), 'code');
  assert.strictEqual(parsed.searchParams.get('client_id'), 'client-id-123', 'client id from SSM');
  assert.strictEqual(parsed.searchParams.get('state'), 'the-state');
  assert.strictEqual(
    parsed.searchParams.get('redirect_uri'),
    'https://claims.sessionably.com/integrations/google/callback'
  );
  console.log('PASS buildAuthUrl (readonly scope + offline + consent)');
}

// --- handler wiring -------------------------------------------------------------

const CALLER_ID = '11111111-1111-1111-1111-111111111111';
const PRACTICE_ID = '22222222-2222-2222-2222-222222222222';
const CONN_ID = '33333333-3333-3333-3333-333333333333';

const dbLib = require(path.join(__dirname, '..', 'lib', 'db.js'));
const googleLib = require(path.join(__dirname, '..', 'lib', 'google_oauth.js'));
const handlerMod = require(path.join(__dirname, '..', 'handlers', 'calendar_oauth.js'));
const handler = handlerMod.handler;

// A tiny in-memory calendar_connections table honoring the
// ON CONFLICT (user_id, calendar_id) DO UPDATE ... RETURNING id, (xmax = 0).
const state = { table: [] };
let seq = 0;

function installDbStub() {
  dbLib.query = async (text, params) => {
    const t = String(text);
    if (/insert into calendar_connections/.test(t)) {
      const [practiceId, userId, accountEmail, calendarId, timeZone] = params;
      const existing = state.table.find(
        (r) => r.user_id === userId && r.calendar_id === calendarId
      );
      if (existing) {
        existing.account_email = accountEmail;
        existing.calendar_time_zone = timeZone;
        existing.status = 'active';
        existing.last_sync_error = null;
        return { rows: [{ id: existing.id, is_new: false }], rowCount: 1 };
      }
      const row = {
        id: seq++ === 0 ? CONN_ID : `44444444-4444-4444-4444-44444444444${seq}`,
        practice_id: practiceId,
        user_id: userId,
        account_email: accountEmail,
        calendar_id: calendarId,
        calendar_time_zone: timeZone,
        status: 'active',
        last_sync_error: null,
      };
      state.table.push(row);
      return { rows: [{ id: row.id, is_new: true }], rowCount: 1 };
    }
    if (/delete from calendar_connections where id = \$1/.test(t)) {
      state.table = state.table.filter((r) => r.id !== params[0]);
      return { rows: [], rowCount: 1 };
    }
    if (/insert into audit_log/.test(t)) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
}

// Stub the provider round-trip: exchangeCode returns the given refresh token;
// listCalendars returns one primary calendar with its own timeZone.
function stubGoogle(refreshToken) {
  googleLib.exchangeCode = async () => ({
    refresh_token: refreshToken,
    access_token: 'short-lived-at',
    expires_in: 3599,
  });
  googleLib.listCalendars = async () => ([
    { id: 'ada@example.com', summary: 'Ada', timeZone: 'America/Denver', primary: true },
  ]);
}

function callbackEvent(stateToken) {
  return {
    requestContext: {
      http: { method: 'GET', path: '/integrations/google/callback' },
      routeKey: 'GET /integrations/google/callback',
    },
    queryStringParameters: { code: 'auth-code', state: stateToken },
  };
}

// --- test 2: state round-trip + tamper rejection --------------------------------

function testStateRoundTrip() {
  const stateToken = handlerMod.makeState({ sub: CALLER_ID, practice_id: PRACTICE_ID });
  const decoded = handlerMod.verifyState(stateToken);
  assert.strictEqual(decoded.sub, CALLER_ID, 'state binds the user');
  assert.strictEqual(decoded.practice_id, PRACTICE_ID, 'state binds the practice');

  // Tampered signature → rejected with a 401 AuthError.
  const tampered = stateToken.slice(0, -2) + (stateToken.endsWith('aa') ? 'bb' : 'aa');
  assert.throws(() => handlerMod.verifyState(tampered), (err) => err.statusCode === 401);

  // A token signed with the RIGHT secret but the WRONG purpose (e.g. a real
  // session JWT) must never pass as a state.
  const sessionLookalike = jwt.sign(
    { sub: CALLER_ID, practice_id: PRACTICE_ID, role: 'clinician' },
    'test-secret',
    { algorithm: 'HS256', expiresIn: '12h' }
  );
  assert.throws(() => handlerMod.verifyState(sessionLookalike), (err) => err.statusCode === 401);

  // Wrong secret → rejected.
  const forged = jwt.sign(
    { sub: CALLER_ID, practice_id: PRACTICE_ID, purpose: 'google_calendar_connect', nonce: 'x' },
    'other-secret',
    { algorithm: 'HS256', expiresIn: '10m' }
  );
  assert.throws(() => handlerMod.verifyState(forged), (err) => err.statusCode === 401);

  // Missing → rejected.
  assert.throws(() => handlerMod.verifyState(undefined), (err) => err.statusCode === 401);

  console.log('PASS state round-trip + tampered/forged/wrong-purpose rejection');
}

// --- test 3: callback conflict path updates, never duplicates -------------------

async function testCallbackConflictUpdates() {
  installDbStub();
  state.table = [];
  ssmPutCalls = [];
  ssmPutFails = false;

  const stateToken = handlerMod.makeState({ sub: CALLER_ID, practice_id: PRACTICE_ID });

  // First connect: fresh insert + parameter write at the row-id path.
  stubGoogle('refresh-token-one');
  const first = await handler(callbackEvent(stateToken));
  assert.strictEqual(first.statusCode, 302, 'success redirects back to the app');
  assert.strictEqual(state.table.length, 1, 'one connection row');
  assert.strictEqual(ssmPutCalls.length, 1, 'one parameter write');
  assert.strictEqual(
    ssmPutCalls[0].name,
    `/claimsub/prod/google/refresh/${CONN_ID}`,
    'parameter path derived from the row id'
  );
  assert.strictEqual(ssmPutCalls[0].value, 'refresh-token-one');

  // Re-connect of the SAME (user, calendar): updates in place, reuses the id,
  // and OVERWRITES the parameter at that id's path.
  stubGoogle('refresh-token-two');
  const second = await handler(callbackEvent(stateToken));
  assert.strictEqual(second.statusCode, 302);
  assert.strictEqual(state.table.length, 1, 'still exactly one row (no duplicate)');
  assert.strictEqual(state.table[0].id, CONN_ID, 'the existing row id is reused');
  assert.strictEqual(ssmPutCalls.length, 2);
  assert.strictEqual(
    ssmPutCalls[1].name,
    `/claimsub/prod/google/refresh/${CONN_ID}`,
    'same parameter path — overwritten, not a second parameter'
  );
  assert.strictEqual(ssmPutCalls[1].value, 'refresh-token-two');

  console.log('PASS callback conflict path (update in place, same id, same parameter)');
}

// --- test 4: SSM write failure deletes the fresh row ----------------------------

async function testSsmFailureDeletesRow() {
  installDbStub();
  state.table = [];
  ssmPutCalls = [];
  ssmPutFails = true;

  const stateToken = handlerMod.makeState({ sub: CALLER_ID, practice_id: PRACTICE_ID });
  stubGoogle('refresh-token-doomed');

  const res = await handler(callbackEvent(stateToken));
  assert.strictEqual(res.statusCode, 502, 'storage failure is an error, not a silent success');
  assert.strictEqual(state.table.length, 0, 'the freshly-inserted row is deleted');

  // White-labeling: the client-facing error never names the vendor.
  const body = JSON.parse(res.body);
  assert.ok(body.error, 'an error message is returned');
  assert.ok(!/google/i.test(res.body), 'no vendor name in the client-facing error');
  assert.ok(!/refresh-token-doomed/.test(res.body), 'no token value leaks into the response');

  ssmPutFails = false;
  console.log('PASS SSM-failure path (row deleted, vendor-free error)');
}

(async function main() {
  await testAuthUrl();
  testStateRoundTrip();
  await testCallbackConflictUpdates();
  await testSsmFailureDeletesRow();
  console.log('PASS google_oauth.test.js');
})().catch((err) => {
  console.error('FAIL google_oauth.test.js');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
