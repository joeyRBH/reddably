'use strict';

// Unit test — a REPLACEMENT (CMS frequency 7) claim must NOT charge the platform
// fee, while an ordinary claim still does.
//
// A replacement is a new claim row that supersedes a claim on which the 5% fee was
// already collected. Charging again would bill the patient a second fee for the
// same service. The authoritative skip lives in the fee-context handler (the client
// also skips the call, but that must not be the only guard): POST
// /claims/{id}/charge-fee/context returns { charge:false, reason:'replacement_claim' }
// for a replacement, and { charge:true, ... } for an ordinary claim.
//
// DB and auth are mocked through the require cache (same approach as
// claim_test_submission_gate.test.js); nothing here touches a database or Stripe.
//
//   node backend/tests/claim_fee_replacement.test.js

const assert = require('node:assert');
const path = require('node:path');

function mock(rel, exports) {
  const resolved = require.resolve(path.join(__dirname, '..', rel));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const PRACTICE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const CLAIM_ID = '2f1c9a3e-7b4d-4c2a-9e11-abcdef012345';
const ORIGINAL_ID = '4b4b4b4b-1c2d-4e3f-8a40-abcdef040506';

// Scriptable claim under test; a client with a saved payment method and a practice
// with a 5% fee — everything an ordinary claim needs to reach charge:true, so a
// charge:false result can only be the replacement skip.
const state = {
  claim: null,
  alreadyPaid: false,
};

function claimRow(over) {
  return {
    id: CLAIM_ID, practice_id: PRACTICE_ID, status: 'submitted', billed_amount: '150.00',
    client_id: 'c1', clinician_id: USER_ID, session_id: 's1', is_hidden: false,
    submission_frequency_code: null, corrects_claim_id: null,
    ...over,
  };
}

mock('lib/db.js', {
  query: async (sql, params) => {
    if (/select practice_id from users/i.test(sql)) {
      return { rows: [{ practice_id: PRACTICE_ID }], rowCount: 1 };
    }
    if (/from claims\b/i.test(sql)) {
      return { rows: state.claim ? [state.claim] : [], rowCount: state.claim ? 1 : 0 };
    }
    if (/from transactions\b/i.test(sql)) {
      return { rows: [], rowCount: state.alreadyPaid ? 1 : 0 };
    }
    if (/from clients\b/i.test(sql)) {
      return { rows: [{ id: 'c1', stripe_customer_id: 'cus_1', payment_method_id: 'pm_1' }], rowCount: 1 };
    }
    if (/from practices\b/i.test(sql)) {
      return { rows: [{ id: PRACTICE_ID, platform_fee_percent: '5' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
});

mock('lib/auth.js', {
  requireAuth: () => ({ user: { sub: USER_ID, practice_id: PRACTICE_ID, role: 'practice_admin' } }),
  AuthError: class AuthError extends Error {},
});

const claimFee = require(path.join(__dirname, '..', 'handlers', 'claim_fee.js'));

const contextEvent = (id) => ({
  requestContext: { http: { method: 'POST', path: `/claims/${id}/charge-fee/context` } },
  rawPath: `/claims/${id}/charge-fee/context`,
  pathParameters: { id },
  headers: { authorization: 'Bearer x' },
  body: '{}',
});

(async () => {
  // 1. Ordinary claim → charges the fee (5% of $150 = 750 cents).
  state.claim = claimRow({});
  state.alreadyPaid = false;
  let res = await claimFee.handler(contextEvent(CLAIM_ID));
  let payload = JSON.parse(res.body);
  assert.strictEqual(res.statusCode, 200, 'ordinary: 200');
  assert.strictEqual(payload.charge, true, 'ordinary claim charges the platform fee');
  assert.strictEqual(payload.amount_cents, 750, 'ordinary claim charges 5% of the billed amount');

  // 2. Replacement via corrects_claim_id → NO charge, reason replacement_claim.
  state.claim = claimRow({ corrects_claim_id: ORIGINAL_ID, submission_frequency_code: '7' });
  res = await claimFee.handler(contextEvent(CLAIM_ID));
  payload = JSON.parse(res.body);
  assert.strictEqual(res.statusCode, 200, 'replacement: 200');
  assert.strictEqual(payload.charge, false, 'a replacement claim does NOT charge the platform fee');
  assert.strictEqual(payload.reason, 'replacement_claim', 'and says why');

  // 3. Replacement identified by frequency alone (no reference set) → still skipped.
  state.claim = claimRow({ submission_frequency_code: '7', corrects_claim_id: null });
  res = await claimFee.handler(contextEvent(CLAIM_ID));
  payload = JSON.parse(res.body);
  assert.strictEqual(payload.charge, false, 'frequency 7 alone is enough to skip the fee');
  assert.strictEqual(payload.reason, 'replacement_claim', 'reason is replacement_claim');

  // 4. The replacement skip is checked BEFORE already_charged: even if a prior fee
  //    row somehow existed, a replacement is reported as replacement_claim (it never
  //    reaches the charge path at all).
  state.claim = claimRow({ corrects_claim_id: ORIGINAL_ID, submission_frequency_code: '7' });
  state.alreadyPaid = true;
  res = await claimFee.handler(contextEvent(CLAIM_ID));
  payload = JSON.parse(res.body);
  assert.strictEqual(payload.charge, false, 'replacement never charges');
  assert.strictEqual(payload.reason, 'replacement_claim', 'replacement reason wins over already_charged');

  // 5. Control: an ordinary claim that was ALREADY charged skips too — proving the
  //    ordinary path can still say "no" for the RIGHT reason, so case 1's charge:true
  //    really is the fee firing, not a mock that always charges.
  state.claim = claimRow({});
  state.alreadyPaid = true;
  res = await claimFee.handler(contextEvent(CLAIM_ID));
  payload = JSON.parse(res.body);
  assert.strictEqual(payload.charge, false, 'ordinary + already charged → skip');
  assert.strictEqual(payload.reason, 'already_charged', 'for the already_charged reason, not replacement');

  console.log('claim_fee_replacement.test.js: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
