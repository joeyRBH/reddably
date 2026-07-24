'use strict';

// Handler-level tests for procedure_modifiers on the sessions resource, with a
// mocked lib/db and a real JWT. Backend validation is AUTHORITATIVE, so these
// assert the full contract on both create and update:
//
//   * accepted + normalized: trimmed, uppercased, blanks dropped, de-duplicated
//     (order preserved), and PERSISTED as the cleaned array;
//   * rejected with a 400: a non-array, a non-string element, a code that is not
//     exactly two alphanumeric characters, and more than four DISTINCT codes;
//   * OMISSION: a create with no modifiers persists NULL (absent), never '' / [];
//   * the edit round-trip: a PATCH preserves the modifiers, and a later GET
//     returns them — a save that is lost on edit is a failure.
//
//   node --test backend/tests/session_procedure_modifiers.test.js

const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

process.env.JWT_SECRET = 'test-secret-for-unit-only';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const CLINICIAN_ID = '22222222-2222-4222-8222-222222222222';

// --- mock lib/db BEFORE requiring the handler --------------------------------
// A single in-memory session row (`store`) so create → GET → update → GET share
// state and the edit round-trip is real. Captures the last INSERT/UPDATE params.
let store = null;
let lastInsertParams = null;
let lastUpdateParams = null;

function rowFromInsert(p) {
  // Column order of the non-recurring INSERT in handlers/sessions.js:
  // practice_id, client_id, clinician_id, session_date, duration_minutes,
  // cpt_code, diagnosis_codes, place_of_service, procedure_modifiers, fee, notes, status
  return {
    id: '33333333-3333-4333-8333-333333333333',
    practice_id: p[0], client_id: p[1], clinician_id: p[2], session_date: p[3],
    duration_minutes: p[4], cpt_code: p[5], diagnosis_codes: p[6], place_of_service: p[7],
    procedure_modifiers: p[8], fee: p[9], notes: p[10], status: p[11] || 'scheduled',
    recurrence_group_id: null, is_hidden: false,
    created_at: '2026-07-24T00:00:00Z', updated_at: '2026-07-24T00:00:00Z',
  };
}

// Apply a dynamic `update sessions set <col> = $n, ... where ...` to the store.
function applyUpdate(sql, params) {
  const m = /set\s+(.+?)\s+where/is.exec(sql);
  const cols = m[1].split(',').map((s) => s.split('=')[0].trim());
  cols.forEach((col, i) => { store[col] = params[i]; });
  store.updated_at = '2026-07-24T01:00:00Z';
  return store;
}

const fakeDb = {
  query: async (sql, params) => {
    if (/select\s+practice_id\s+from\s+users/i.test(sql)) {
      return { rows: [{ practice_id: 'practice-1' }], rowCount: 1 };
    }
    if (/select\s+1\s+from\s+clients/i.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
    if (/select\s+1\s+from\s+users/i.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
    if (/insert\s+into\s+sessions/i.test(sql)) {
      lastInsertParams = params;
      store = rowFromInsert(params);
      return { rows: [store], rowCount: 1 };
    }
    if (/update\s+sessions\s+set/i.test(sql)) {
      lastUpdateParams = params;
      if (!store) return { rows: [], rowCount: 0 };
      return { rows: [applyUpdate(sql, params)], rowCount: 1 };
    }
    if (/select\s+\*\s+from\s+sessions/i.test(sql)) {
      return { rows: store ? [store] : [], rowCount: store ? 1 : 0 };
    }
    if (/insert\s+into\s+audit_log/i.test(sql)) return { rows: [], rowCount: 1 };
    throw new Error('unexpected query: ' + sql);
  },
  withTransaction: async (fn) => fn({ query: fakeDb.query }),
};

const dbPath = require.resolve(path.join(__dirname, '..', 'lib', 'db.js'));
require.cache[dbPath] = new Module(dbPath, module);
require.cache[dbPath].filename = dbPath;
require.cache[dbPath].loaded = true;
require.cache[dbPath].exports = fakeDb;

const { sign } = require(path.join(__dirname, '..', 'lib', 'jwt.js'));
const sessions = require(path.join(__dirname, '..', 'handlers', 'sessions.js'));

const token = sign({ id: 'user-1', practice_id: 'practice-1', role: 'practice_admin' });
const authHeaders = { authorization: `Bearer ${token}` };

function createEvent(body) {
  return { httpMethod: 'POST', headers: authHeaders, body: JSON.stringify(body) };
}
function patchEvent(id, body) {
  return { httpMethod: 'PATCH', headers: authHeaders, pathParameters: { id }, body: JSON.stringify(body) };
}
function getEvent(id) {
  return { httpMethod: 'GET', headers: authHeaders, pathParameters: { id } };
}

const baseCreate = { client_id: CLIENT_ID, clinician_id: CLINICIAN_ID, session_date: '2026-06-01', cpt_code: '90837' };
const create = (extra) => sessions.handler(createEvent({ ...baseCreate, ...extra }));

(async () => {
  // --- 1. Accepted + normalized + persisted ----------------------------------
  {
    store = null; lastInsertParams = null;
    const res = await create({ procedure_modifiers: ['95', ' gt ', '95', '', 'HJ'] });
    assert.strictEqual(res.statusCode, 201, `create 201, got ${res.statusCode}: ${res.body}`);
    const session = JSON.parse(res.body).session;
    assert.deepStrictEqual(
      session.procedure_modifiers, ['95', 'GT', 'HJ'],
      'response carries trimmed/uppercased/de-duplicated modifiers, order preserved'
    );
    // Persisted value (INSERT param 9) is the SAME cleaned array — not the raw input.
    assert.deepStrictEqual(lastInsertParams[8], ['95', 'GT', 'HJ'], 'the cleaned array is what is persisted');
  }

  // --- 2. OMISSION: no modifiers persists NULL, never '' / [] -----------------
  {
    store = null; lastInsertParams = null;
    const res = await create({});
    assert.strictEqual(res.statusCode, 201, `create 201, got ${res.statusCode}: ${res.body}`);
    assert.strictEqual(JSON.parse(res.body).session.procedure_modifiers, null, 'absent modifiers → null in the shape');
    assert.strictEqual(lastInsertParams[8], null, 'absent modifiers persist as NULL (not [] / "")');
  }

  // --- 3. Rejected with 400: malformed shapes --------------------------------
  const bad = {
    'a non-array (string)': '95,GT',
    'a non-array (object)': { 0: '95' },
    'a non-string element': ['95', 5],
    'a one-character code': ['9'],
    'a three-character code': ['950'],
    'a non-alphanumeric code': ['9-'],
    'more than four distinct codes': ['95', 'GT', '59', '76', '77'],
  };
  for (const [label, value] of Object.entries(bad)) {
    store = null; lastInsertParams = null;
    const res = await create({ procedure_modifiers: value });
    assert.strictEqual(res.statusCode, 400, `${label} → 400 (got ${res.statusCode}: ${res.body})`);
    assert.match(JSON.parse(res.body).error, /procedure_modifiers/i, `${label}: error names the field`);
    assert.strictEqual(lastInsertParams, null, `${label}: nothing persisted on a rejected create`);
  }

  // Four DISTINCT codes is the boundary — allowed.
  {
    store = null;
    const res = await create({ procedure_modifiers: ['95', 'GT', '59', '76'] });
    assert.strictEqual(res.statusCode, 201, `four modifiers allowed (got ${res.statusCode}: ${res.body})`);
    assert.deepStrictEqual(JSON.parse(res.body).session.procedure_modifiers, ['95', 'GT', '59', '76']);
  }

  // Five codes that COLLAPSE to four distinct are fine (dedupe before the cap).
  {
    store = null;
    const res = await create({ procedure_modifiers: ['95', 'GT', '59', '76', '95'] });
    assert.strictEqual(res.statusCode, 201, `dupes do not trip the cap (got ${res.statusCode}: ${res.body})`);
    assert.deepStrictEqual(JSON.parse(res.body).session.procedure_modifiers, ['95', 'GT', '59', '76']);
  }

  // --- 4. Edit round-trip: PATCH preserves, GET returns ----------------------
  {
    store = null;
    const created = await create({ procedure_modifiers: ['95'] });
    const id = JSON.parse(created.body).session.id;

    // Patch an unrelated field; the modifiers must survive untouched.
    const patched1 = await sessions.handler(patchEvent(id, { fee: 175 }));
    assert.strictEqual(patched1.statusCode, 200, `patch 200, got ${patched1.statusCode}: ${patched1.body}`);
    assert.deepStrictEqual(
      JSON.parse(patched1.body).session.procedure_modifiers, ['95'],
      'modifiers survive a PATCH that does not touch them'
    );

    // Patch the modifiers themselves; the new value round-trips.
    const patched2 = await sessions.handler(patchEvent(id, { procedure_modifiers: ['95', 'gt'] }));
    assert.strictEqual(patched2.statusCode, 200, `patch 200, got ${patched2.statusCode}: ${patched2.body}`);
    assert.deepStrictEqual(
      JSON.parse(patched2.body).session.procedure_modifiers, ['95', 'GT'],
      'PATCH updates + normalizes the modifiers'
    );
    assert.deepStrictEqual(lastUpdateParams[0], ['95', 'GT'], 'the cleaned array is what the UPDATE persists');

    // A fresh GET reads them back — proving they were persisted, not just echoed.
    const got = await sessions.handler(getEvent(id));
    assert.strictEqual(got.statusCode, 200, `get 200, got ${got.statusCode}: ${got.body}`);
    assert.deepStrictEqual(
      JSON.parse(got.body).session.procedure_modifiers, ['95', 'GT'],
      'a subsequent GET returns the persisted modifiers'
    );

    // Clearing on edit is supported by the API: PATCH [] persists NULL.
    const cleared = await sessions.handler(patchEvent(id, { procedure_modifiers: [] }));
    assert.strictEqual(cleared.statusCode, 200, `patch 200, got ${cleared.statusCode}: ${cleared.body}`);
    assert.strictEqual(
      JSON.parse(cleared.body).session.procedure_modifiers, null,
      'PATCH with [] clears the modifiers to NULL'
    );
    assert.strictEqual(lastUpdateParams[0], null, 'clearing persists NULL');

    // A malformed PATCH is rejected and does not corrupt the stored value.
    const rejected = await sessions.handler(patchEvent(id, { procedure_modifiers: ['bad!'] }));
    assert.strictEqual(rejected.statusCode, 400, `malformed PATCH → 400 (got ${rejected.statusCode})`);
    assert.match(JSON.parse(rejected.body).error, /procedure_modifiers/i);
  }

  console.log('session_procedure_modifiers.test.js: OK');
})().catch((err) => {
  console.error('session_procedure_modifiers.test.js: FAIL', err);
  process.exit(1);
});
