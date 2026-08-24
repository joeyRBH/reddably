'use strict';

// Unit test — the test-submission gate on POST /claims/{id}/submit.
//
// buildSubmissionBody decides 'T' vs 'P' (see claim_usage_indicator.test.js);
// THIS test pins down how a request is allowed to reach that decision at all.
// The rule the handler enforces is "two independent gates, fail closed":
//
//   * the deployment must opt in (STEDI_ALLOW_TEST_SUBMISSIONS), and
//   * a practice admin must ask for it explicitly on this request.
//
// The case that matters most is the refusal. If a request asked for a test claim
// and the environment forbids it, the handler must NOT quietly submit a
// production claim instead — that would file synthetic patient data as a real
// claim against a real payer. So every negative case below asserts that the
// clearinghouse was never called, not merely that the response was a 403.
//
// The DB, audit log, clearinghouse and auth are mocked through the require cache
// (same approach as refund_approve_adapter.test.js); nothing here touches a
// database or the network.
//
//   node backend/tests/claim_test_submission_gate.test.js

const assert = require('node:assert');
const path = require('node:path');

function mock(rel, exports) {
  const resolved = require.resolve(path.join(__dirname, '..', rel));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const PRACTICE_ID = '11111111-1111-4111-8111-111111111111';
const CLAIM_ID = '2f1c9a3e-7b4d-4c2a-9e11-abcdef012345';
const USER_ID = '33333333-3333-4333-8333-333333333333';

// Minimal rows: enough for buildClaimContext and the pre-submission guards
// (billing address present, subscriber DOB present, non-dependent).
const ROWS = {
  users: { id: USER_ID, practice_id: PRACTICE_ID, first_name: 'Dana', last_name: 'Cruz', npi: '1987654320' },
  claims: {
    id: CLAIM_ID, practice_id: PRACTICE_ID, status: 'draft', billed_amount: '150.00',
    session_id: 's1', client_id: 'c1', clinician_id: USER_ID, insurance_record_id: 'i1',
  },
  sessions: { id: 's1', cpt_code: '90837', session_date: '2026-06-01', diagnosis_codes: ['F411'] },
  clients: {
    id: 'c1', first_name: 'Jamie', last_name: 'Rivera', date_of_birth: '2010-08-01',
    gender: 'female', address_line1: '5 Elm St', city: 'Denver', state: 'CO', postal_code: '80203',
  },
  practices: {
    id: PRACTICE_ID, name: 'Test Practice', npi: '1234567890', tax_id: '123456789',
    address_line1: '1 Main St', city: 'Denver', state: 'CO', postal_code: '80202',
  },
  insurance_records: { id: 'i1', payer_id: '60054', carrier_name: 'Aetna', member_id: 'W123456789' },
};

// Route each query by the table it reads. loadPracticeId is the only one that
// selects a bare column rather than *, so it is matched first.
mock('lib/db.js', {
  query: async (sql) => {
    if (/select practice_id from users/i.test(sql)) return { rows: [{ practice_id: PRACTICE_ID }], rowCount: 1 };
    for (const table of Object.keys(ROWS)) {
      if (new RegExp(`from ${table}\\b`, 'i').test(sql)) return { rows: [ROWS[table]], rowCount: 1 };
    }
    if (/provider_billing_profiles/i.test(sql)) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  },
  withTransaction: async (fn) => fn({
    query: async () => ({ rows: [{ ...ROWS.claims, status: 'submitted' }], rowCount: 1 }),
  }),
});

mock('lib/audit.js', { audit: async () => {}, sanitizeFields: (x) => x });

mock('lib/claims.js', {
  // [] makes buildClaimContext fall back to the anchor session, so these cases
  // stay exactly the single-service-line claims they were written to test.
  loadClaimSessions: async () => [],
  insertGroupedClaim: async () => ({}),
  primaryInsuranceForClient: async () => ROWS.insurance_records,
  logClaimEvent: async () => {},
  logClaimAcknowledgment: async () => {},
  insertDraftClaim: async () => ({}),
  ensurePatientControlNumber: async () => 'PCN123',
});

// Scriptable principal — the role under test.
const auth = { role: 'practice_admin' };
mock('lib/auth.js', {
  requireAuth: () => ({ user: { sub: USER_ID, practice_id: PRACTICE_ID, role: auth.role } }),
  AuthError: class AuthError extends Error {},
});

// Spy adapter. `advertisesTestMode` toggles whether it exports
// testSubmissionsAllowed at all — that is how the mock / claim_md adapters, which
// cannot file a Stedi test claim, present themselves.
const adapterSpy = { calls: 0, lastCtx: null, advertisesTestMode: true, allowed: false };
mock('lib/clearinghouse/index.js', {
  getClearinghouse: () => {
    const adapter = {
      name: 'stedi',
      submitClaim: async (ctx) => {
        adapterSpy.calls += 1;
        adapterSpy.lastCtx = ctx;
        return { control_number: 'CN1', claim_number: 'CN1', status: 'submitted', raw: {} };
      },
    };
    if (adapterSpy.advertisesTestMode) {
      adapter.testSubmissionsAllowed = () => adapterSpy.allowed;
    }
    return adapter;
  },
});

const claims = require(path.join(__dirname, '..', 'handlers', 'claims.js'));

const submitEvent = (body) => ({
  requestContext: { http: { method: 'POST' }, routeKey: 'POST /claims/{id}/submit' },
  pathParameters: { id: CLAIM_ID },
  headers: { authorization: 'Bearer x' },
  // `confirmed` skips the soft warning hold, which is not what this test is about.
  body: JSON.stringify({ confirmed: true, ...body }),
});

function reset(over) {
  adapterSpy.calls = 0;
  adapterSpy.lastCtx = null;
  adapterSpy.advertisesTestMode = true;
  adapterSpy.allowed = false;
  auth.role = 'practice_admin';
  Object.assign(adapterSpy, over || {});
}

(async () => {
  // 1. Ordinary submit: no flag, no test mode, and the adapter is called with a
  //    ctx that carries nothing to make buildSubmissionBody choose 'T'.
  reset();
  let res = await claims.handler(submitEvent({}));
  assert.strictEqual(res.statusCode, 200, 'ordinary submit succeeds');
  assert.strictEqual(adapterSpy.calls, 1, 'ordinary submit reaches the clearinghouse');
  assert.strictEqual(
    adapterSpy.lastCtx.testSubmission,
    undefined,
    'ordinary submit does not mark the ctx as a test submission'
  );

  // 2. Fully authorized test submission: admin + environment opt-in.
  reset({ allowed: true });
  res = await claims.handler(submitEvent({ test_submission: true }));
  assert.strictEqual(res.statusCode, 200, 'authorized test submission succeeds');
  assert.strictEqual(adapterSpy.calls, 1, 'authorized test submission reaches the clearinghouse');
  assert.strictEqual(
    adapterSpy.lastCtx.testSubmission,
    true,
    'authorized test submission marks the ctx so the builder emits usageIndicator T'
  );

  // 3. THE IMPORTANT ONE: admin asks for a test claim, environment forbids it.
  //    Refused outright — never downgraded to a real claim.
  reset({ allowed: false });
  res = await claims.handler(submitEvent({ test_submission: true }));
  assert.strictEqual(res.statusCode, 403, 'test submission is refused when the environment forbids it');
  assert.strictEqual(
    adapterSpy.calls,
    0,
    'a forbidden test submission is NOT silently filed as a production claim'
  );

  // 4. Same, for an adapter that cannot file a test claim at all (mock/claim_md
  //    do not export testSubmissionsAllowed).
  reset({ advertisesTestMode: false });
  res = await claims.handler(submitEvent({ test_submission: true }));
  assert.strictEqual(res.statusCode, 403, 'adapter that cannot test-submit refuses');
  assert.strictEqual(adapterSpy.calls, 0, 'and does not submit anything');

  // 5. Role gate: a clinician cannot flip it, even where the environment allows.
  reset({ allowed: true });
  auth.role = 'clinician';
  res = await claims.handler(submitEvent({ test_submission: true }));
  assert.strictEqual(res.statusCode, 403, 'a clinician cannot request a test submission');
  assert.strictEqual(adapterSpy.calls, 0, 'and nothing is submitted');

  reset({ allowed: true });
  auth.role = 'billing_staff';
  res = await claims.handler(submitEvent({ test_submission: true }));
  assert.strictEqual(res.statusCode, 403, 'billing staff cannot request a test submission');
  assert.strictEqual(adapterSpy.calls, 0, 'and nothing is submitted');

  // 6. The flag must be exactly `true`. A truthy JSON value is not a request, and
  //    must not be treated as one in either direction: the claim still submits,
  //    as production.
  for (const loose of ['true', 1, 'yes']) {
    reset({ allowed: true });
    res = await claims.handler(submitEvent({ test_submission: loose }));
    assert.strictEqual(res.statusCode, 200, `test_submission:${JSON.stringify(loose)} submits normally`);
    assert.strictEqual(
      adapterSpy.lastCtx.testSubmission,
      undefined,
      `test_submission:${JSON.stringify(loose)} is not an explicit test request`
    );
  }

  console.log('claim_test_submission_gate.test.js: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
