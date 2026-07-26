'use strict';

// Place-of-service validation (837P 2300/CLM05-01 / CMS-1500 Box 24B).
//
// A live claim was rejected by the payer because a session carried
// place_of_service = "office" — the word, not the CMS two-digit code 11. The
// value must now be a valid two-character CMS code everywhere it is written or
// transmitted:
//
//   * handlers/sessions.js — create and update 400 on an invalid value; empty /
//     null stay allowed (a session may be saved before billing details are known);
//   * lib/place_of_service.js — the shared code list + isValidPlaceOfService;
//   * lib/clearinghouse/stedi.js — the 837P builder THROWS on an invalid stored
//     value (a wrong value is a rejected claim) and defaults an EMPTY one to '11'
//     (an absent value is a safe default).
//
// Normalization choice, asserted below: a padded value ("11 ") is NORMALIZED by
// trimming (cleanText in the handler / cleanStr in the adapter both trim); any
// surviving non-list value — including a lowercase word like "office" — is
// rejected outright.
//
//   node --test backend/tests/place_of_service.test.js

const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

process.env.JWT_SECRET = 'test-secret-for-unit-only';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const CLINICIAN_ID = '22222222-2222-4222-8222-222222222222';

// --- mock lib/db BEFORE requiring the handler --------------------------------
// A single in-memory session row so create → GET → update share state. Captures
// the last INSERT/UPDATE params so persistence (not just the echo) is asserted.
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
const posLib = require(path.join(__dirname, '..', 'lib', 'place_of_service.js'));
const stedi = require(path.join(__dirname, '..', 'lib', 'clearinghouse', 'stedi.js'));

const token = sign({ id: 'user-1', practice_id: 'practice-1', role: 'practice_admin' });
const authHeaders = { authorization: `Bearer ${token}` };

function createEvent(body) {
  return { httpMethod: 'POST', headers: authHeaders, body: JSON.stringify(body) };
}
function patchEvent(id, body) {
  return { httpMethod: 'PATCH', headers: authHeaders, pathParameters: { id }, body: JSON.stringify(body) };
}

const baseCreate = { client_id: CLIENT_ID, clinician_id: CLINICIAN_ID, session_date: '2026-06-01', cpt_code: '90837' };
const create = (extra) => sessions.handler(createEvent({ ...baseCreate, ...extra }));

// 837P builder fixture (mirrors claim_pos_diagnoses_group.test.js).
const builderBase = {
  claim: { id: '2f1c9a3e-7b4d-4c2a-9e11-abcdef012345', billed_amount: '150.00' },
  practice: {
    name: 'Test Practice', npi: '1234567890',
    address_line1: '1 Main St', city: 'Denver', state: 'CO', postal_code: '80202',
  },
  clinician: {},
  client: {
    first_name: 'Jamie', last_name: 'Rivera', date_of_birth: '2010-08-01', gender: 'female',
    address_line1: '5 Elm St', city: 'Denver', state: 'CO', postal_code: '80203',
  },
  session: { cpt_code: '90837', session_date: '2026-06-01', diagnosis_codes: ['F411'] },
  insurance: { payer_id: '60054', carrier_name: 'Aetna', member_id: 'W123456789' },
};
const buildWithSession = (s) =>
  stedi.buildSubmissionBody({ ...builderBase, session: { ...builderBase.session, ...s } }).body;

(async () => {
  // --- 0. The shared helper itself --------------------------------------------
  {
    for (const { code } of posLib.PLACE_OF_SERVICE_CODES) {
      assert.strictEqual(posLib.isValidPlaceOfService(code), true, `${code} is valid`);
    }
    for (const bad of ['office', 'OFFICE', '1', '111', '11 ', ' 11', '', null, undefined, 11, '99']) {
      assert.strictEqual(
        posLib.isValidPlaceOfService(bad), false,
        `${JSON.stringify(bad)} is invalid (callers trim; the helper is strict)`
      );
    }
  }

  // --- 1. "office" is rejected on session create ------------------------------
  {
    store = null; lastInsertParams = null;
    const res = await create({ place_of_service: 'office' });
    assert.strictEqual(res.statusCode, 400, `"office" → 400 (got ${res.statusCode}: ${res.body})`);
    const error = JSON.parse(res.body).error;
    assert.match(error, /place_of_service/i, 'error names the field');
    assert.match(error, /11/, 'error names the allowed codes');
    assert.strictEqual(lastInsertParams, null, 'nothing persisted on a rejected create');
  }

  // --- 2. "11" is accepted and persisted --------------------------------------
  {
    store = null; lastInsertParams = null;
    const res = await create({ place_of_service: '11' });
    assert.strictEqual(res.statusCode, 201, `"11" → 201 (got ${res.statusCode}: ${res.body})`);
    assert.strictEqual(JSON.parse(res.body).session.place_of_service, '11');
    assert.strictEqual(lastInsertParams[7], '11', '"11" is what is persisted (INSERT param 8)');
  }

  // --- 3. Empty and null are accepted (persist NULL) ---------------------------
  for (const empty of ['', null, undefined]) {
    store = null; lastInsertParams = null;
    const res = await create(empty === undefined ? {} : { place_of_service: empty });
    assert.strictEqual(
      res.statusCode, 201,
      `${JSON.stringify(empty)} place_of_service → 201 (got ${res.statusCode}: ${res.body})`
    );
    assert.strictEqual(JSON.parse(res.body).session.place_of_service, null);
    assert.strictEqual(lastInsertParams[7], null, 'empty persists as NULL');
  }

  // --- 4. Padded "11 " is NORMALIZED (trimmed) to "11" — the chosen behavior ---
  {
    store = null; lastInsertParams = null;
    const res = await create({ place_of_service: '11 ' });
    assert.strictEqual(res.statusCode, 201, `"11 " → 201 (got ${res.statusCode}: ${res.body})`);
    assert.strictEqual(lastInsertParams[7], '11', 'padding is trimmed before validation and persistence');
  }
  // …but a lowercase / non-code word is rejected, not normalized (there is no
  // case-mapping for numeric CMS codes — "office" simply is not one).
  {
    store = null;
    const res = await create({ place_of_service: 'Office' });
    assert.strictEqual(res.statusCode, 400, `"Office" → 400 (got ${res.statusCode}: ${res.body})`);
  }

  // --- 5. Update path enforces the same rule ----------------------------------
  {
    store = null;
    const created = await create({ place_of_service: '11' });
    const id = JSON.parse(created.body).session.id;

    const badPatch = await sessions.handler(patchEvent(id, { place_of_service: 'office' }));
    assert.strictEqual(badPatch.statusCode, 400, `PATCH "office" → 400 (got ${badPatch.statusCode}: ${badPatch.body})`);
    assert.strictEqual(store.place_of_service, '11', 'rejected PATCH leaves the stored value untouched');

    const goodPatch = await sessions.handler(patchEvent(id, { place_of_service: '10' }));
    assert.strictEqual(goodPatch.statusCode, 200, `PATCH "10" → 200 (got ${goodPatch.statusCode}: ${goodPatch.body})`);
    assert.strictEqual(JSON.parse(goodPatch.body).session.place_of_service, '10');
    assert.strictEqual(lastUpdateParams[0], '10', 'the valid code is what the UPDATE persists');

    const clearPatch = await sessions.handler(patchEvent(id, { place_of_service: '' }));
    assert.strictEqual(clearPatch.statusCode, 200, `PATCH "" (clear) → 200 (got ${clearPatch.statusCode}: ${clearPatch.body})`);
    assert.strictEqual(JSON.parse(clearPatch.body).session.place_of_service, null, 'clearing on edit persists NULL');
  }

  // --- 6. 837P builder: throws on invalid, defaults '11' on empty --------------
  {
    assert.throws(
      () => buildWithSession({ place_of_service: 'office' }),
      /place.of.service|place_of_service/i,
      'builder refuses to build with an invalid stored value'
    );
    assert.strictEqual(
      buildWithSession({ place_of_service: null }).claimInformation.placeOfServiceCode,
      '11',
      'empty place_of_service defaults to office (11)'
    );
    assert.strictEqual(
      buildWithSession({ place_of_service: '  02  ' }).claimInformation.placeOfServiceCode,
      '02',
      'padded stored value is trimmed, then accepted'
    );
  }

  console.log('place_of_service.test.js: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
