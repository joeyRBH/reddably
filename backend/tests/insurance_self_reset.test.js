'use strict';

// Handler-level test for insurance_records PATCH — the self-reset case.
//
// The core hazard: the insurance form hides the policyholder fields when the
// patient's relationship is 'self' and drops them from the payload, so a naive
// update would LEAVE stale policyholder PHI (name / DOB / gender / address) on the
// record. When the relationship flips back to a dependent value, that stale data
// would resurface and file onto the wrong subscriber. updateRecord must therefore
// force-clear every policyholder column to NULL when the relationship is set to
// 'self'. This exercises both directions:
//
//   * flip to 'self'      → every policyholder column is written NULL (even though
//                           the body carries none of them), and patient data is
//                           never touched;
//   * a dependent update  → the policyholder columns are written from the body,
//                           NOT cleared.
//
// Mocks lib/db (captures the UPDATE) with a real JWT. No network, no real DB.
//
//   node backend/tests/insurance_self_reset.test.js

const assert = require('node:assert');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const Module = require('node:module');

process.env.JWT_SECRET = 'test-secret-for-unit-only';

const RECORD_ID = '11111111-2222-3333-4444-555555555555';

// A stored record that currently carries FULL policyholder (dependent) data — the
// stale state a self-flip must wipe.
function staleDependentRow() {
  return {
    id: RECORD_ID,
    practice_id: 'practice-1',
    client_id: 'client-1',
    carrier_name: 'Surest',
    member_id: 'W123',
    group_number: 'GRP1',
    plan_type: null,
    subscriber_relationship: 'child',
    subscriber_name: 'Pat Rivera',
    subscriber_dob: '1965-02-10',
    subscriber_gender: 'male',
    subscriber_address_line1: '99 Holder Ave',
    subscriber_address_line2: 'Unit 4',
    subscriber_city: 'Boulder',
    subscriber_state: 'CO',
    subscriber_postal_code: '80301',
    oon_deductible_total: null,
    oon_deductible_met: null,
    oon_reimbursement_rate: null,
    payer_id: '60054',
    is_primary: true,
    is_hidden: false,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
  };
}

let capturedUpdate = null; // { text, params }

const fakeDb = {
  query: async (sql, params) => {
    if (/select practice_id from users where id/i.test(sql)) {
      return { rows: [{ practice_id: 'practice-1' }], rowCount: 1 };
    }
    // beforeRes snapshot (updateRecord loads the row before updating).
    if (/select \* from insurance_records where id/i.test(sql)) {
      return { rows: [staleDependentRow()], rowCount: 1 };
    }
    if (/update insurance_records set/i.test(sql)) {
      capturedUpdate = { text: sql, params };
      // Reflect the SETs back onto the row so the response is coherent. We only
      // need rowCount>0 and a shaped row; apply nothing fancy.
      return { rows: [staleDependentRow()], rowCount: 1 };
    }
    if (/insert into audit_log/i.test(sql)) return { rows: [], rowCount: 1 };
    throw new Error('unexpected query: ' + sql);
  },
};

const dbPath = require.resolve(path.join(__dirname, '..', 'lib', 'db.js'));
require.cache[dbPath] = new Module(dbPath, module);
require.cache[dbPath].filename = dbPath;
require.cache[dbPath].loaded = true;
require.cache[dbPath].exports = fakeDb;

const { sign } = require(path.join(__dirname, '..', 'lib', 'jwt.js'));
const insurance = require(path.join(__dirname, '..', 'handlers', 'insurance_records.js'));

function patchEvent(body) {
  const token = sign({ id: 'user-1', practice_id: 'practice-1', role: 'practice_admin' });
  return {
    httpMethod: 'PATCH',
    headers: { authorization: `Bearer ${token}` },
    pathParameters: { id: RECORD_ID },
    body: JSON.stringify(body),
  };
}

// The columns that describe the OTHER person (the policyholder) — cleared on self.
const POLICYHOLDER_COLS = [
  'subscriber_name',
  'subscriber_dob',
  'subscriber_gender',
  'subscriber_address_line1',
  'subscriber_address_line2',
  'subscriber_city',
  'subscriber_state',
  'subscriber_postal_code',
];

// Find the bound value for `col = $n` in the captured UPDATE.
function boundValue(col) {
  const m = new RegExp(`\\b${col}\\s*=\\s*\\$(\\d+)`).exec(capturedUpdate.text);
  assert.ok(m, `expected the UPDATE to set ${col}`);
  return capturedUpdate.params[Number(m[1]) - 1];
}

(async () => {
  // --- 1. Flip to 'self': every policyholder column is force-cleared to NULL ----
  capturedUpdate = null;
  const res = await insurance.handler(patchEvent({ subscriber_relationship: 'self' }));
  assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
  assert.ok(capturedUpdate, 'an UPDATE was issued');

  for (const col of POLICYHOLDER_COLS) {
    assert.strictEqual(
      boundValue(col),
      null,
      `${col} must be cleared to NULL when relationship flips to self`
    );
  }
  // The relationship itself is written as 'self'.
  assert.strictEqual(boundValue('subscriber_relationship'), 'self', 'relationship set to self');

  // --- 2. A dependent update writes policyholder data, does NOT clear it ---------
  capturedUpdate = null;
  const dep = await insurance.handler(patchEvent({
    subscriber_relationship: 'child',
    subscriber_name: 'Pat Rivera',
    subscriber_gender: 'male',
    subscriber_address_line1: '99 Holder Ave',
    subscriber_city: 'Boulder',
    subscriber_state: 'CO',
    subscriber_postal_code: '80301',
  }));
  assert.strictEqual(dep.statusCode, 200, `expected 200, got ${dep.statusCode}: ${dep.body}`);
  assert.strictEqual(boundValue('subscriber_name'), 'Pat Rivera', 'dependent name written from body');
  assert.strictEqual(boundValue('subscriber_gender'), 'male', 'dependent gender written from body');
  assert.strictEqual(boundValue('subscriber_city'), 'Boulder', 'dependent city written from body');

  // --- 3. An invalid policyholder gender is rejected with a 400 -----------------
  const bad = await insurance.handler(patchEvent({
    subscriber_relationship: 'child',
    subscriber_gender: 'nonbinary_typo',
  }));
  assert.strictEqual(bad.statusCode, 400, 'invalid subscriber_gender → 400');
  assert.match(JSON.parse(bad.body).error, /subscriber_gender/i, 'names the offending field');

  console.log('PASS insurance_self_reset.test.js');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
