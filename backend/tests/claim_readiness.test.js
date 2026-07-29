'use strict';

// Unit test — shared claim readiness (backend/lib/claim_readiness.js) and its
// two callers: the POST /claims/{id}/submit gate and the additive readiness
// projection on GET /claims.
//
// The contract this pins down:
//
//   * ONE implementation of every pure pre-submission rule. handlers/claims.js
//     defines none of them and only re-exports the shared ones, so the list can
//     never drift from the gate.
//   * The submit path is UNCHANGED by the extraction: same blocker order, same
//     HTTP statuses, same exact wording, same soft-warning codes/messages,
//     same confirmed:true behaviour, same replacement gates, and — critically —
//     the missing-insurance blocker still runs BEFORE the patient control
//     number is minted, so a blocked submit never mutates or transmits.
//   * GET /claims gains `readiness` on DRAFT rows (needs_correction /
//     review_warning / ready_to_review), `readiness: null` on every other
//     status, computed set-based with no per-claim query, and WITHOUT returning
//     the PHI the evaluation read (DOBs, addresses, member ids).
//
// The DB, audit log, clearinghouse and auth are mocked through the require
// cache (same approach as claim_submit_integrity.test.js); nothing here touches
// a database or the network. Fixtures are synthetic ids and placeholder names.
//
//   node backend/tests/claim_readiness.test.js

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function mock(rel, exports) {
  const resolved = require.resolve(path.join(__dirname, '..', rel));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const PRACTICE_ID = '11111111-1111-4111-8111-111111111111';
const CLAIM_ID = '2f1c9a3e-7b4d-4c2a-9e11-abcdef012345';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const PCN = 'PCNTEST0000000001';
const PATIENT_DOB = '1990-08-01';

const readiness = require(path.join(__dirname, '..', 'lib', 'claim_readiness.js'));

// ===========================================================================
// Part A — the shared module OWNS the validators; the handler only re-exports
// ===========================================================================

const handlerSource = fs.readFileSync(
  path.join(__dirname, '..', 'handlers', 'claims.js'), 'utf8'
);

// No second implementation may live in the handler. A `function <name>(` in
// handlers/claims.js is exactly the duplicate this refactor removes.
[
  'missingBillingAddressField',
  'missingSubscriberField',
  'missingDependentPolicyholderField',
  'invalidSessionPlaceOfService',
  'dateOnlyKey',
  'ageInYears',
  'evaluateSubmissionWarnings',
  'missingInsuranceRecord',
].forEach((name) => {
  assert.ok(
    !new RegExp(`function\\s+${name}\\s*\\(`).test(handlerSource),
    `handlers/claims.js must not define ${name} — lib/claim_readiness.js owns it`
  );
  assert.ok(
    typeof readiness[name] === 'function',
    `lib/claim_readiness.js exports ${name}`
  );
});

// The handler must call the shared module, and must no longer build the
// place-of-service blocker message itself.
assert.match(handlerSource, /require\('\.\.\/lib\/claim_readiness'\)/,
  'handlers/claims.js imports the shared readiness module');
assert.ok(
  !/Session place of service is not a valid CMS code/.test(handlerSource),
  'the place-of-service blocker wording lives only in the shared module'
);
assert.ok(
  !/Attach an insurance record before submitting/.test(handlerSource),
  'the missing-insurance wording lives only in the shared module'
);

// ===========================================================================
// Part B — the pure evaluator
// ===========================================================================

const OK_PRACTICE = { address_line1: '1 Main St', city: 'Denver', state: 'CO', postal_code: '80202' };
const OK_CLIENT = { date_of_birth: PATIENT_DOB };
const OK_SESSION = { place_of_service: '10' };
const OK_INSURANCE = { subscriber_relationship: 'self', member_id: 'W123456789' };
const OK_CLAIM = { insurance_record_id: 'i1' };

function ctx(over) {
  return Object.assign({
    claim: OK_CLAIM, session: OK_SESSION, client: OK_CLIENT,
    practice: OK_PRACTICE, insurance: OK_INSURANCE,
  }, over || {});
}

// 1. Nothing objects -> ready_to_review (never "ready to submit").
let r = readiness.evaluateClaimReadiness(ctx());
assert.strictEqual(r.state, 'ready_to_review');
assert.deepStrictEqual(r.blockers, []);
assert.deepStrictEqual(r.warnings, []);
assert.ok(readiness.READINESS_STATES.indexOf('ready_to_submit') === -1,
  'the ready state is ready_to_review, never ready_to_submit');

// 2. A soft warning alone -> review_warning, and the claim is NOT blocked.
r = readiness.evaluateClaimReadiness(ctx({
  insurance: { subscriber_relationship: 'self', member_id: 'AB' },
}));
assert.strictEqual(r.state, 'review_warning');
assert.deepStrictEqual(r.blockers, []);
assert.deepStrictEqual(r.warnings.map((w) => w.code), ['member_id_length_unusual']);

// 3. Any hard blocker -> needs_correction, whatever the warnings say.
r = readiness.evaluateClaimReadiness(ctx({ client: { date_of_birth: null } }));
assert.strictEqual(r.state, 'needs_correction');
assert.deepStrictEqual(r.blockers.map((b) => b.code), ['client_date_of_birth']);

// 4. Blockers come back in submit's order, with submit's status codes.
r = readiness.evaluateClaimReadiness({
  claim: { insurance_record_id: null },
  practice: {},
  client: {},
  insurance: { subscriber_relationship: 'child', subscriber_name: '', subscriber_dob: null },
  session: { place_of_service: 'office' },
});
assert.deepStrictEqual(r.blockers.map((b) => b.code), [
  'missing_insurance_record',
  'practice_billing_address',
  'client_date_of_birth',
  'dependent_policyholder',
  'session_place_of_service',
], 'projection emits blockers in the submit gate order');
assert.deepStrictEqual(r.blockers.map((b) => b.status), [400, 422, 422, 422, 422],
  'missing insurance answers 400; the context blockers answer 422');

// 5. A replacement is a review warning here — its DB-dependent gates stay
//    submit-time and are deliberately not duplicated in the projection.
r = readiness.evaluateClaimReadiness(ctx({
  claim: { insurance_record_id: 'i1', submission_frequency_code: '7', corrects_claim_id: 'x' },
}));
assert.strictEqual(r.state, 'review_warning');
assert.deepStrictEqual(r.warnings.map((w) => w.code), ['replacement_claim']);
assert.ok(!('payer_claim_control_number' in r.warnings[0]),
  'the projection never carries the payer claim number');

// 6. Age math is unchanged and deterministic against an injected `asOf`.
assert.strictEqual(readiness.ageInYears('1990-08-01', new Date('2026-07-31T00:00:00Z')), 35);
assert.strictEqual(readiness.ageInYears('1990-08-01', new Date('2026-08-01T00:00:00Z')), 36);
assert.strictEqual(readiness.ageInYears(null), null);

// 7. Soft-warning codes and exact wording are unchanged.
const warned = readiness.evaluateSubmissionWarnings({
  client: { date_of_birth: '1980-01-01' },
  insurance: {
    subscriber_relationship: 'child', subscriber_name: '',
    subscriber_dob: '1980-01-01', member_id: 'AB',
  },
}, new Date('2026-07-28T00:00:00Z'));
assert.deepStrictEqual(warned, [
  { code: 'child_dependent_adult_age', message: 'Patient is listed as a child dependent but is 46 years old.' },
  { code: 'patient_policyholder_same_dob', message: 'Patient and policyholder have the same date of birth.' },
  { code: 'dependent_missing_policyholder_name', message: 'Dependent claim has no policyholder name.' },
  { code: 'member_id_length_unusual', message: 'Member ID length looks unusual.' },
], 'warning codes and messages are byte-for-byte unchanged');

// ===========================================================================
// Part C + D — the handler, against a mocked database
// ===========================================================================

// Mutable fixtures the SQL router answers from. Each submit case flips exactly
// the field under test, so the blocker order is asserted on real responses.
const fixtures = {
  practices: { id: PRACTICE_ID, name: 'Test Practice', npi: '1234567890', tax_id: '123456789', ...OK_PRACTICE },
  clients: {
    id: 'c1', first_name: 'Jamie', last_name: 'Rivera', preferred_name: null,
    date_of_birth: PATIENT_DOB, gender: 'female',
    address_line1: '5 Elm St', city: 'Denver', state: 'CO', postal_code: '80203',
  },
  sessions: {
    id: 's1', cpt_code: '90837', session_date: '2026-06-01',
    diagnosis_codes: ['F411'], place_of_service: '10',
  },
  insurance_records: {
    id: 'i1', payer_id: '60054', carrier_name: 'Aetna', member_id: 'W123456789',
    is_hidden: false, subscriber_relationship: 'self', subscriber_name: null, subscriber_dob: null,
  },
  users: { id: USER_ID, practice_id: PRACTICE_ID, first_name: 'Dana', last_name: 'Cruz', npi: '1987654320' },
};

function freshDraft() {
  return {
    id: CLAIM_ID, practice_id: PRACTICE_ID, status: 'draft', billed_amount: '150.00',
    session_id: 's1', client_id: 'c1', clinician_id: USER_ID, insurance_record_id: 'i1',
    control_number: null, patient_control_number: null, claim_number: null,
    submission_frequency_code: null, corrects_claim_id: null, payer_claim_control_number: null,
    prior_authorization_number: null, submitted_at: null, is_hidden: false,
    created_at: '2026-06-02T00:00:00.000Z', updated_at: '2026-06-02T00:00:00.000Z',
  };
}

const state = { claim: freshDraft(), listRows: [] };
const sqlLog = [];
const none = () => ({ rows: [], rowCount: 0 });
const one = (row) => ({ rows: [{ ...row }], rowCount: 1 });

function applyClaimUpdate(sql, params) {
  if (/set patient_control_number = coalesce/.test(sql)) {
    if (state.claim.patient_control_number == null) {
      state.claim = { ...state.claim, patient_control_number: params[0] };
    }
    return one({ patient_control_number: state.claim.patient_control_number });
  }
  if (/set status = 'submitted'/.test(sql)) {
    if (state.claim.status !== 'draft') return none();
    state.claim = { ...state.claim, status: 'submitted', submitted_at: 'NOW', control_number: null };
    return one(state.claim);
  }
  if (/set control_number = \$1/.test(sql)) {
    state.claim = { ...state.claim, control_number: params[0] };
    return one(state.claim);
  }
  throw new Error('db mock: unexpected claims UPDATE: ' + sql);
}

function route(sql, params) {
  sqlLog.push(sql);
  if (/select practice_id from users/i.test(sql)) return one({ practice_id: PRACTICE_ID });
  if (/^\s*update claims/i.test(sql)) return applyClaimUpdate(sql, params);
  // The list query — the one joined, set-based read GET /claims performs.
  if (/from claims c\b/i.test(sql)) return { rows: state.listRows.map((x) => ({ ...x })), rowCount: state.listRows.length };
  // Prior-replacement probe.
  if (/select 1 from claims/i.test(sql)) return none();
  if (/from claims\b/i.test(sql)) return one(state.claim);
  if (/provider_billing_profiles/i.test(sql)) return none();
  for (const table of Object.keys(fixtures)) {
    if (new RegExp(`from ${table}\\b`, 'i').test(sql)) return one(fixtures[table]);
  }
  return none();
}

mock('lib/db.js', {
  query: async (sql, params) => route(sql, params),
  withTransaction: async (fn) => fn({ query: async (sql, params) => route(sql, params) }),
});
mock('lib/audit.js', { audit: async () => {}, sanitizeFields: (x) => x });
mock('lib/claims.js', {
  primaryInsuranceForClient: async () => fixtures.insurance_records,
  logClaimEvent: async () => {},
  logClaimAcknowledgment: async () => {},
  insertDraftClaim: async () => ({}),
  insertReplacementClaim: async () => ({}),
  ensurePatientControlNumber: async (q, practiceId, claim) => {
    if (claim.patient_control_number) return claim.patient_control_number;
    const res = await q.query(
      `update claims set patient_control_number = coalesce(patient_control_number, $1)
        where id = $2 and practice_id = $3 returning patient_control_number`,
      [PCN, claim.id, practiceId]
    );
    return res.rows[0].patient_control_number;
  },
});
mock('lib/auth.js', {
  requireAuth: () => ({ user: { sub: USER_ID, practice_id: PRACTICE_ID, role: 'practice_admin' } }),
  AuthError: class AuthError extends Error {},
});

const adapterState = { submitCalls: 0 };
mock('lib/clearinghouse/index.js', {
  getClearinghouse: () => ({
    name: 'stedi',
    submitClaim: async () => {
      adapterState.submitCalls += 1;
      return { control_number: 'CN-REAL', claim_number: 'CN-REAL', status: 'submitted', raw: { ok: true } };
    },
  }),
});

const claims = require(path.join(__dirname, '..', 'handlers', 'claims.js'));

// The handler's exported validators ARE the shared ones (same function object).
[
  'missingBillingAddressField', 'missingSubscriberField',
  'missingDependentPolicyholderField', 'invalidSessionPlaceOfService',
  'evaluateSubmissionWarnings', 'ageInYears',
].forEach((name) => {
  assert.strictEqual(claims[name], readiness[name],
    `handlers/claims.js re-exports the shared ${name}, it does not reimplement it`);
});
// The pre-existing export surface is preserved exactly — nothing added, and
// dateOnlyKey stays unexported as it always was.
assert.strictEqual(claims.dateOnlyKey, undefined, 'dateOnlyKey remains unexported from the handler');
assert.ok(Array.isArray(claims.REGENERATABLE_STATUSES) && Array.isArray(claims.REPLACEABLE_STATUSES));
assert.strictEqual(typeof claims.isReplacementClaim, 'function');
assert.strictEqual(typeof claims.submissionOutcomeUnknown, 'function');
assert.strictEqual(typeof claims.shapeClaim, 'function');

const submitEvent = (body) => ({
  requestContext: { http: { method: 'POST' }, routeKey: 'POST /claims/{id}/submit' },
  pathParameters: { id: CLAIM_ID },
  headers: { authorization: 'Bearer x' },
  body: JSON.stringify(body || {}),
});
const listEvent = (query) => ({
  requestContext: { http: { method: 'GET' }, routeKey: 'GET /claims' },
  pathParameters: null,
  headers: { authorization: 'Bearer x' },
  queryStringParameters: query || null,
});
const parse = (res) => JSON.parse(res.body);

function resetSubmitFixtures() {
  state.claim = freshDraft();
  fixtures.practices = { ...fixtures.practices, ...OK_PRACTICE };
  fixtures.clients = { ...fixtures.clients, date_of_birth: PATIENT_DOB };
  fixtures.sessions = { ...fixtures.sessions, place_of_service: '10' };
  fixtures.insurance_records = {
    ...fixtures.insurance_records, is_hidden: false,
    subscriber_relationship: 'self', subscriber_name: null, subscriber_dob: null,
    member_id: 'W123456789',
  };
  adapterState.submitCalls = 0;
  sqlLog.length = 0;
}

// Assert a blocked submit left the claim alone and sent nothing.
function assertNoMutationOrTransmission(label) {
  assert.strictEqual(adapterState.submitCalls, 0, label + ': nothing was transmitted');
  assert.strictEqual(state.claim.status, 'draft', label + ': the claim is still a draft');
  assert.strictEqual(state.claim.submitted_at, null, label + ': submitted_at untouched');
  assert.strictEqual(state.claim.control_number, null, label + ': no control number');
  assert.ok(!sqlLog.some((s) => /update claims\s+set status = 'submitted'/i.test(s)),
    label + ': no submission attempt was recorded');
}

(async () => {
  const bodies = [];

  // --- C1. Missing insurance: 400, exact message, BEFORE the PCN is minted ---
  resetSubmitFixtures();
  state.claim = { ...freshDraft(), insurance_record_id: null };
  let res = await claims.handler(submitEvent({ confirmed: true }));
  bodies.push(['missing insurance', res.statusCode, res.body]);
  assert.strictEqual(res.statusCode, 400, 'missing insurance answers 400 (not 422)');
  assert.strictEqual(parse(res).error, 'Attach an insurance record before submitting.');
  assert.ok(!sqlLog.some((s) => /patient_control_number = coalesce/.test(s)),
    'the missing-insurance blocker runs BEFORE the patient control number is minted');
  assert.strictEqual(state.claim.patient_control_number, null, 'no control number was created');
  assertNoMutationOrTransmission('missing insurance');

  // --- C2. Blocker ORDER: with every context blocker true at once, submit
  //         answers the billing address first, then DOB, then dependent, then POS.
  resetSubmitFixtures();
  fixtures.practices = { ...fixtures.practices, address_line1: null };
  fixtures.clients = { ...fixtures.clients, date_of_birth: null };
  fixtures.sessions = { ...fixtures.sessions, place_of_service: 'office' };
  fixtures.insurance_records = {
    ...fixtures.insurance_records,
    subscriber_relationship: 'child', subscriber_name: '', subscriber_dob: null,
  };

  res = await claims.handler(submitEvent({ confirmed: true }));
  bodies.push(['blocker 1/4 billing address', res.statusCode, res.body]);
  assert.strictEqual(res.statusCode, 422);
  assert.strictEqual(parse(res).error,
    'Practice billing address is required before submitting claims.');
  assertNoMutationOrTransmission('billing address');

  sqlLog.length = 0;
  fixtures.practices = { ...fixtures.practices, ...OK_PRACTICE };
  res = await claims.handler(submitEvent({ confirmed: true }));
  bodies.push(['blocker 2/4 client DOB', res.statusCode, res.body]);
  assert.strictEqual(res.statusCode, 422);
  assert.strictEqual(parse(res).error,
    "Client date of birth is required before submitting claims. Ask the client to complete intake, or add it on the client's chart.");
  assertNoMutationOrTransmission('client DOB');

  sqlLog.length = 0;
  fixtures.clients = { ...fixtures.clients, date_of_birth: PATIENT_DOB };
  res = await claims.handler(submitEvent({ confirmed: true }));
  bodies.push(['blocker 3/4 dependent policyholder', res.statusCode, res.body]);
  assert.strictEqual(res.statusCode, 422);
  assert.strictEqual(parse(res).error,
    'Policyholder name and date of birth are required on the insurance record before submitting a dependent claim. Edit the client\'s insurance to add them.');
  assertNoMutationOrTransmission('dependent policyholder');

  sqlLog.length = 0;
  fixtures.insurance_records = {
    ...fixtures.insurance_records,
    subscriber_relationship: 'self', subscriber_name: null, subscriber_dob: null,
  };
  res = await claims.handler(submitEvent({ confirmed: true }));
  bodies.push(['blocker 4/4 place of service', res.statusCode, res.body]);
  assert.strictEqual(res.statusCode, 422);
  assert.strictEqual(parse(res).error,
    'Session place of service is not a valid CMS code. Edit the session and pick one of: ' +
    '02 (Telehealth (patient not in their home)), 10 (Telehealth (patient in their home)), ' +
    '11 (Office), 12 (Home), 49 (Independent clinic), 53 (Community mental health center).');
  assertNoMutationOrTransmission('place of service');

  // --- C3. Soft warnings stay advisory: held without confirmed, sent with it --
  resetSubmitFixtures();
  fixtures.insurance_records = { ...fixtures.insurance_records, member_id: 'AB' };
  res = await claims.handler(submitEvent({}));
  bodies.push(['soft warning hold', res.statusCode, res.body]);
  assert.strictEqual(res.statusCode, 200, 'a soft warning is a 200 hold, never a blocker');
  assert.strictEqual(parse(res).requires_confirmation, true);
  assert.deepStrictEqual(parse(res).warnings, [
    { code: 'member_id_length_unusual', message: 'Member ID length looks unusual.' },
  ]);
  assertNoMutationOrTransmission('soft warning hold');

  res = await claims.handler(submitEvent({ confirmed: true }));
  bodies.push(['soft warning confirmed', res.statusCode, res.body]);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(parse(res).claim.status, 'submitted', 'confirmed:true submits');
  assert.strictEqual(adapterState.submitCalls, 1, 'confirmed:true transmits exactly once');

  // --- C4. Replacement gates remain submit-time and intact -------------------
  resetSubmitFixtures();
  state.claim = { ...freshDraft(), submission_frequency_code: '7', payer_claim_control_number: null };
  res = await claims.handler(submitEvent({ confirmed: true }));
  bodies.push(['replacement missing payer claim #', res.statusCode, res.body]);
  assert.strictEqual(res.statusCode, 422);
  assert.strictEqual(parse(res).error,
    "This replacement is missing the payer's original claim number, so it cannot be filed. Re-create the replacement with that number.");
  assertNoMutationOrTransmission('replacement missing payer claim number');

  resetSubmitFixtures();
  state.claim = {
    ...freshDraft(), submission_frequency_code: '7',
    payer_claim_control_number: 'PAYER-1', corrects_claim_id: null,
  };
  res = await claims.handler(submitEvent({ confirmed: true }));
  bodies.push(['replacement missing lineage', res.statusCode, res.body]);
  assert.strictEqual(res.statusCode, 422);
  assert.strictEqual(parse(res).error, 'This replacement does not reference the claim it replaces.');
  assertNoMutationOrTransmission('replacement missing lineage');

  // The replacement confirmation warning still leads, and still carries the
  // payer claim number for the dialog (the projection's copy does not).
  resetSubmitFixtures();
  state.claim = {
    ...freshDraft(), submission_frequency_code: '7',
    payer_claim_control_number: 'PAYER-1', corrects_claim_id: CLAIM_ID,
  };
  // loadClaim for the original returns the same (accepted) row.
  const acceptedOriginal = { ...freshDraft(), status: 'paid', control_number: 'CN-OLD' };
  const originalRoute = state.claim;
  state.claim = originalRoute;
  const savedRoute = route;
  // Answer the corrects_claim_id lookup with an accepted original.
  let claimLookups = 0;
  mock('lib/db.js', {
    query: async (sql, params) => {
      if (/from claims where id/i.test(sql)) {
        claimLookups += 1;
        return claimLookups === 1 ? one(state.claim) : one(acceptedOriginal);
      }
      return savedRoute(sql, params);
    },
    withTransaction: async (fn) => fn({ query: async (sql, params) => savedRoute(sql, params) }),
  });
  delete require.cache[require.resolve(path.join(__dirname, '..', 'handlers', 'claims.js'))];
  const claims2 = require(path.join(__dirname, '..', 'handlers', 'claims.js'));
  res = await claims2.handler(submitEvent({}));
  bodies.push(['replacement confirmation', res.statusCode, res.body]);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(parse(res).requires_confirmation, true);
  assert.deepStrictEqual(parse(res).warnings[0], {
    code: 'replacement_claim',
    message: 'This replaces a previously accepted payer claim — it does not create a new original claim.',
    payer_claim_control_number: 'PAYER-1',
  }, 'the submit-side replacement warning is unchanged, payer claim number included');

  // Restore the plain db mock + handler for the list tests.
  mock('lib/db.js', {
    query: async (sql, params) => route(sql, params),
    withTransaction: async (fn) => fn({ query: async (sql, params) => route(sql, params) }),
  });
  delete require.cache[require.resolve(path.join(__dirname, '..', 'handlers', 'claims.js'))];
  const claims3 = require(path.join(__dirname, '..', 'handlers', 'claims.js'));

  // --- D. GET /claims readiness projection ----------------------------------

  // One joined row per claim, exactly the shape the list query selects.
  function listRow(over) {
    return Object.assign({}, freshDraft(), {
      id: 'claim-' + Math.random().toString(16).slice(2, 8),
      client_first_name: 'Jamie', client_last_name: 'Rivera', client_preferred_name: null,
      client_date_of_birth: PATIENT_DOB,
      session_date: '2026-06-01', session_cpt_code: '90837',
      session_diagnosis_codes: ['F411', 'F331'], session_place_of_service: '10',
      payer_name: 'Aetna', payer_id: '60054',
      ins_is_hidden: false, ins_member_id: 'W123456789',
      ins_subscriber_relationship: 'self', ins_subscriber_name: null, ins_subscriber_dob: null,
      practice_address_line1: '1 Main St', practice_city: 'Denver',
      practice_state: 'CO', practice_postal_code: '80202',
    }, over || {});
  }

  const ready = listRow({ id: 'd-ready' });
  const warnRow = listRow({ id: 'd-warn', ins_member_id: 'AB' });
  const blockedRow = listRow({ id: 'd-blocked', client_date_of_birth: null });
  const paidRow = listRow({ id: 'h-paid', status: 'paid', control_number: 'CN-1', submitted_at: '2026-06-05T00:00:00.000Z' });
  const sentinelRow = listRow({ id: 'h-sentinel', status: 'submitted', control_number: null, submitted_at: '2026-06-06T00:00:00.000Z' });

  state.listRows = [ready, warnRow, blockedRow, paidRow, sentinelRow];
  sqlLog.length = 0;
  res = await claims3.handler(listEvent(null));
  bodies.push(['GET /claims', res.statusCode, res.body]);
  assert.strictEqual(res.statusCode, 200);
  const rows = parse(res).claims;
  const byId = {};
  rows.forEach((row) => { byId[row.id] = row; });

  // 9. The three projected states.
  assert.strictEqual(byId['d-ready'].readiness.state, 'ready_to_review');
  assert.strictEqual(byId['d-warn'].readiness.state, 'review_warning');
  assert.deepStrictEqual(byId['d-warn'].readiness.warnings.map((w) => w.code), ['member_id_length_unusual']);
  assert.strictEqual(byId['d-blocked'].readiness.state, 'needs_correction');
  assert.deepStrictEqual(byId['d-blocked'].readiness.blockers.map((b) => b.code), ['client_date_of_birth']);
  assert.strictEqual(byId['d-blocked'].readiness.blockers[0].status, 422);

  // 10. Non-draft rows carry readiness: null — including the unconfirmed-
  //     submission sentinel (submitted, no control number), which is history
  //     like any other non-draft and is NOT special-cased here.
  assert.strictEqual(byId['h-paid'].readiness, null, 'a paid claim has readiness: null');
  assert.ok('readiness' in byId['h-paid'], 'the key is present on every row (stable shape)');
  assert.strictEqual(byId['h-sentinel'].readiness, null,
    'the unconfirmed-submission sentinel is plain history: readiness null');

  // Additive display fields on every row.
  assert.strictEqual(byId['d-ready'].cpt_code, '90837');
  assert.deepStrictEqual(byId['d-ready'].diagnosis_codes, ['F411', 'F331']);
  assert.strictEqual(byId['d-ready'].place_of_service, '10');
  assert.strictEqual(byId['d-ready'].payer_name, 'Aetna');
  assert.strictEqual(byId['d-ready'].billed_amount, '150.00');
  // No existing field was dropped.
  ['id', 'practice_id', 'session_id', 'client_id', 'clinician_id', 'insurance_record_id',
   'claim_number', 'control_number', 'patient_control_number', 'status', 'billed_amount',
   'submitted_at', 'created_at', 'client_name', 'session_date', 'payer_id',
  ].forEach((k) => assert.ok(k in byId['d-ready'], 'existing list field ' + k + ' is still returned'));

  // 11. Set-based: exactly one read against claims regardless of row count.
  const claimReads = sqlLog.filter((s) => /from claims/i.test(s));
  assert.strictEqual(claimReads.length, 1,
    'readiness for 5 claims costs ONE query — no per-claim lookup');
  assert.match(claimReads[0], /order by c\.created_at desc/, 'default ordering unchanged');
  assert.match(claimReads[0], /left join insurance_records/, 'insurance stays a LEFT join');
  assert.match(claimReads[0], /c\.is_hidden = false/, 'hidden claims stay excluded');

  // 12. Validation inputs are never returned. The evaluator read the client DOB,
  //     the subscriber fields, the member id and the practice address; none of
  //     them may appear in the response.
  const raw = res.body;
  assert.ok(raw.indexOf(PATIENT_DOB) === -1, 'the client date of birth is not in the list response');
  assert.ok(raw.indexOf('W123456789') === -1, 'the member id is not in the list response');
  assert.ok(raw.indexOf('1 Main St') === -1, 'the practice address is not in the list response');
  [
    'date_of_birth', 'client_date_of_birth', 'ins_member_id', 'ins_subscriber_dob',
    'ins_subscriber_name', 'ins_subscriber_relationship', 'ins_is_hidden',
    'practice_address_line1', 'practice_city', 'practice_state', 'practice_postal_code',
    'client_first_name', 'client_last_name',
  ].forEach((k) => assert.ok(!(k in byId['d-ready']), 'internal context field ' + k + ' is not exposed'));

  // A hidden insurance record is treated as absent — exactly what submit's
  // is_hidden-filtered load does — so the projection blocks on missing coverage
  // context rather than reading a record submit would never see.
  state.listRows = [listRow({
    id: 'd-hidden-ins', ins_is_hidden: true,
    ins_subscriber_relationship: 'child', ins_subscriber_name: '', ins_subscriber_dob: null,
  })];
  res = await claims3.handler(listEvent(null));
  const hidden = parse(res).claims[0];
  assert.strictEqual(hidden.readiness.state, 'ready_to_review',
    'a hidden insurance record is invisible to the projection, as it is to submit');

  // 13. Existing filters still behave.
  state.listRows = [paidRow];
  sqlLog.length = 0;
  res = await claims3.handler(listEvent({ status: 'paid' }));
  assert.strictEqual(res.statusCode, 200);
  assert.match(sqlLog.filter((s) => /from claims/i.test(s))[0], /c\.status = \$2/,
    'the status filter is still applied server-side');
  res = await claims3.handler(listEvent({ status: 'nonsense' }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(parse(res).error,
    'Invalid status. Expected one of: draft, submitted, processing, info_requested, denied, appealed, paid, void.');
  res = await claims3.handler(listEvent({ client_id: 'not-a-uuid' }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(parse(res).error, 'Invalid client_id.');

  // Print real response bodies so the contract is visible in the run output,
  // not just an assertion count.
  console.log('\n--- observed responses -------------------------------------------');
  bodies.forEach(([label, status, bodyText]) => {
    console.log(`[${status}] ${label}\n      ${bodyText.slice(0, 320)}`);
  });
  console.log('------------------------------------------------------------------\n');

  console.log('PASS claim_readiness.test.js');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
