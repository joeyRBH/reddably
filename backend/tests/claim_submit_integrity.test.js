'use strict';

// Unit test — submit-path integrity on POST /claims/{id}/submit + /reconcile.
//
// The incident this pins down: a submit Lambda timed out mid-call, the
// clearinghouse ACCEPTED the claim in that same minute, and SC still showed the
// claim unsubmitted — so a retry would have filed a duplicate. The contract now:
//
//   * the attempt (and its patient control number) is recorded BEFORE the
//     network call, so a dead Lambda leaves the claim in "submitted, no control
//     number" = outcome unknown, never a state that invites a retry;
//   * resubmitting an unknown-outcome claim is refused with a reconcile message;
//   * POST /claims/{id}/reconcile adopts the clearinghouse's real status (or an
//     operator resolution), and a clearinghouse "no match" changes NOTHING —
//     only an explicit 'not_received' resolution returns the claim to draft;
//   * the patient control number survives every path, so any resubmission is
//     recognizable as a duplicate by the clearinghouse.
//
// The DB, audit log, clearinghouse and auth are mocked through the require
// cache (same approach as claim_test_submission_gate.test.js); nothing here
// touches a database or the network. The DB mock is stateful: claim UPDATEs
// apply their WHERE gates to an in-memory row, so the atomic-transition
// guarantees are what is actually asserted.
//
//   node backend/tests/claim_submit_integrity.test.js

const assert = require('node:assert');
const path = require('node:path');

function mock(rel, exports) {
  const resolved = require.resolve(path.join(__dirname, '..', rel));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const PRACTICE_ID = '11111111-1111-4111-8111-111111111111';
const CLAIM_ID = '2f1c9a3e-7b4d-4c2a-9e11-abcdef012345';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const PCN = 'PCNTEST0000000001';

// Minimal rows: enough for buildClaimContext and the pre-submission guards
// (billing address present, subscriber DOB present, non-dependent).
const ROWS = {
  users: { id: USER_ID, practice_id: PRACTICE_ID, first_name: 'Dana', last_name: 'Cruz', npi: '1987654320' },
  sessions: { id: 's1', cpt_code: '90837', session_date: '2026-06-01', diagnosis_codes: ['F411'] },
  clients: {
    id: 'c1', first_name: 'Jamie', last_name: 'Rivera', date_of_birth: '1990-08-01',
    gender: 'female', address_line1: '5 Elm St', city: 'Denver', state: 'CO', postal_code: '80203',
  },
  practices: {
    id: PRACTICE_ID, name: 'Test Practice', npi: '1234567890', tax_id: '123456789',
    address_line1: '1 Main St', city: 'Denver', state: 'CO', postal_code: '80202',
  },
  insurance_records: { id: 'i1', payer_id: '60054', carrier_name: 'Aetna', member_id: 'W123456789' },
};

function freshDraft() {
  return {
    id: CLAIM_ID, practice_id: PRACTICE_ID, status: 'draft', billed_amount: '150.00',
    session_id: 's1', client_id: 'c1', clinician_id: USER_ID, insurance_record_id: 'i1',
    control_number: null, patient_control_number: null, claim_number: null,
    submission_frequency_code: null, corrects_claim_id: null,
    prior_authorization_number: null, submitted_at: null, is_hidden: false,
  };
}

// Mutable state the DB mock applies UPDATEs to, plus an ordering timeline so the
// record-before-send guarantee is asserted on actual call order.
const state = { claim: freshDraft() };
const timeline = [];
const events = [];   // logClaimEvent calls
const acks = [];     // logClaimAcknowledgment calls
const audits = [];   // audit() actions

const none = () => ({ rows: [], rowCount: 0 });
const one = (row) => ({ rows: [{ ...row }], rowCount: 1 });

function pendingGateHolds(sql) {
  // Every write that resolves a pending attempt must be gated on the exact
  // sentinel; enforce the claim really is in that state when the SQL says so.
  if (!/status = 'submitted' and control_number is null/.test(sql)) return true;
  return state.claim.status === 'submitted' && state.claim.control_number == null;
}

function applyClaimUpdate(sql, params) {
  if (/set status = 'submitted'/.test(sql)) {
    // Pre-send attempt record — atomic draft gate is the concurrency guard.
    if (state.claim.status !== 'draft' || state.claim.is_hidden) return none();
    state.claim = {
      ...state.claim, status: 'submitted', submitted_at: 'NOW', control_number: null,
      clearinghouse: params[0], submission_frequency_code: params[1],
      prior_authorization_number: params[2],
    };
    timeline.push('db:record-attempt');
    return one(state.claim);
  }
  if (/set status = 'draft'/.test(sql)) {
    if (!pendingGateHolds(sql)) return none();
    state.claim = { ...state.claim, status: 'draft', submitted_at: null };
    timeline.push('db:revert-draft');
    return one(state.claim);
  }
  if (/set status = \$1/.test(sql)) {
    if (!pendingGateHolds(sql)) return none();
    state.claim = {
      ...state.claim, status: params[0],
      control_number: params[1] != null ? params[1] : state.claim.control_number,
    };
    timeline.push('db:adopt-status');
    return one(state.claim);
  }
  if (/set control_number = \$1/.test(sql) && /claim_number = coalesce/.test(sql)) {
    // Success path: fill in the clearinghouse acknowledgment.
    if (!pendingGateHolds(sql)) return none();
    state.claim = {
      ...state.claim, control_number: params[0],
      claim_number: state.claim.claim_number || params[1], clearinghouse_payload: params[2],
    };
    timeline.push('db:confirm-accepted');
    return one(state.claim);
  }
  if (/set control_number = \$1/.test(sql)) {
    // Operator resolution 'received'.
    if (!pendingGateHolds(sql)) return none();
    state.claim = { ...state.claim, control_number: params[0] };
    timeline.push('db:record-received');
    return one(state.claim);
  }
  if (/set patient_control_number = coalesce/.test(sql)) {
    if (state.claim.patient_control_number == null) {
      state.claim = { ...state.claim, patient_control_number: params[0] };
      timeline.push('db:persist-pcn');
    }
    return one({ patient_control_number: state.claim.patient_control_number });
  }
  throw new Error(`db mock: unexpected claims UPDATE: ${sql}`);
}

function route(sql, params) {
  if (/select practice_id from users/i.test(sql)) return one({ practice_id: PRACTICE_ID });
  if (/^\s*update claims/i.test(sql)) return applyClaimUpdate(sql, params);
  if (/from claims\b/i.test(sql)) return one(state.claim);
  if (/provider_billing_profiles/i.test(sql)) return none();
  for (const table of Object.keys(ROWS)) {
    if (new RegExp(`from ${table}\\b`, 'i').test(sql)) return one(ROWS[table]);
  }
  return none();
}

mock('lib/db.js', {
  query: async (sql, params) => route(sql, params),
  withTransaction: async (fn) => fn({ query: async (sql, params) => route(sql, params) }),
});

mock('lib/audit.js', {
  audit: async (event, authCtx, entry) => { audits.push(entry); },
  sanitizeFields: (x) => x,
});

// Real-behavior mirror of lib/claims.js: ensurePatientControlNumber reuses a
// stored value and otherwise mints + persists one through the (recorded) UPDATE.
mock('lib/claims.js', {
  primaryInsuranceForClient: async () => ROWS.insurance_records,
  logClaimEvent: async (q, e) => { events.push(e); },
  logClaimAcknowledgment: async (q, a) => { if (a && a.payload != null) acks.push(a); },
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

// Scriptable adapter: mode drives submitClaim, reconcileResult drives reconcile.
const adapterState = { mode: 'ok', submitCalls: 0, reconcileCalls: 0, reconcileResult: null };
mock('lib/clearinghouse/index.js', {
  getClearinghouse: () => ({
    name: 'stedi',
    submitClaim: async () => {
      adapterState.submitCalls += 1;
      timeline.push('adapter:submit');
      if (adapterState.mode === 'timeout') {
        throw new Error('Stedi request to /professionalclaims/v3/submission timed out after 15000ms');
      }
      if (adapterState.mode === 'reject') {
        const e = new Error('[33] Invalid Patient Control Number');
        e.isRejection = true;
        e.rejection = { code: '33', description: '[33] Invalid Patient Control Number' };
        throw e;
      }
      return { control_number: 'CN-REAL', claim_number: 'CN-REAL', status: 'submitted', raw: { ok: true } };
    },
    reconcileSubmission: async ({ patientControlNumber }) => {
      adapterState.reconcileCalls += 1;
      adapterState.lastReconcilePcn = patientControlNumber;
      return adapterState.reconcileResult;
    },
  }),
});

const claims = require(path.join(__dirname, '..', 'handlers', 'claims.js'));

const actionEvent = (action, body) => ({
  requestContext: { http: { method: 'POST' }, routeKey: `POST /claims/{id}/${action}` },
  pathParameters: { id: CLAIM_ID },
  headers: { authorization: 'Bearer x' },
  body: JSON.stringify(body || {}),
});
// `confirmed` skips the soft-warning hold, which is not what this test is about.
const submitEvent = () => actionEvent('submit', { confirmed: true });

const body = (res) => JSON.parse(res.body);

// Capture console output so the PHI-free logging contract is assertable.
const logged = [];
const origError = console.error;
const origLog = console.log;
console.error = (...args) => { logged.push(args.join(' ')); };
console.log = (...args) => { logged.push(args.join(' ')); };

(async () => {
  // 1. TIMEOUT: the attempt is recorded before the network call, and the claim
  //    lands in the unknown state with its control number persisted.
  state.claim = freshDraft();
  adapterState.mode = 'timeout';
  let res = await claims.handler(submitEvent());
  assert.strictEqual(res.statusCode, 502, 'timeout returns 502');
  assert.strictEqual(body(res).outcome, 'unknown', 'timeout response is flagged unknown, not failed');
  assert.match(body(res).error, /reconcile/i, 'timeout response tells the user to reconcile, not retry');
  assert.strictEqual(state.claim.status, 'submitted', 'claim is NOT left looking unsubmitted/failed');
  assert.strictEqual(state.claim.control_number, null, 'no control number = outcome unknown sentinel');
  assert.strictEqual(state.claim.patient_control_number, PCN, 'patient control number persisted');
  assert.strictEqual(state.claim.clearinghouse, 'stedi', 'attempt records where it was sent');
  assert.ok(
    timeline.indexOf('db:persist-pcn') < timeline.indexOf('db:record-attempt') &&
    timeline.indexOf('db:record-attempt') < timeline.indexOf('adapter:submit'),
    'control number and attempt are recorded BEFORE the network call'
  );
  const errLine = logged.find((l) => /clearinghouse call failed/.test(l));
  assert.ok(errLine, 'the failure is logged (the incident produced zero logs)');
  assert.ok(errLine.includes(CLAIM_ID) && errLine.includes('class timeout'), 'log carries claim id + failure class');
  assert.ok(!/Rivera|Jamie|W123456789/.test(logged.join('\n')), 'logs carry no PHI');

  // 2. UNSAFE RETRY REFUSED: resubmitting the unknown-state claim never reaches
  //    the clearinghouse and names reconciliation as the remedy.
  const submitCallsBefore = adapterState.submitCalls;
  adapterState.mode = 'ok';
  res = await claims.handler(submitEvent());
  assert.strictEqual(res.statusCode, 409, 'resubmit of an unknown-state claim is refused');
  assert.match(body(res).error, /reconcile/i, 'refusal tells the user to reconcile first');
  assert.match(body(res).error, /duplicate/i, 'refusal explains the duplicate risk');
  assert.strictEqual(adapterState.submitCalls, submitCallsBefore, 'clearinghouse is NOT called on refusal');
  assert.strictEqual(state.claim.patient_control_number, PCN, 'control number untouched by the refusal');

  // 3. REFRESH is also redirected to reconciliation while the outcome is unknown.
  res = await claims.handler(actionEvent('refresh'));
  assert.strictEqual(res.statusCode, 409);
  assert.match(body(res).error, /reconcile/i, 'refresh points at reconciliation');

  // 4. RECONCILE (lookup) ADOPTS the clearinghouse status.
  adapterState.reconcileResult = { found: true, status: 'processing', control_number: null, raw: { r: 1 } };
  res = await claims.handler(actionEvent('reconcile'));
  assert.strictEqual(res.statusCode, 200, 'reconcile succeeds');
  assert.strictEqual(body(res).outcome, 'adopted');
  assert.strictEqual(state.claim.status, 'processing', 'clearinghouse status adopted');
  assert.strictEqual(adapterState.lastReconcilePcn, PCN, 'lookup keys on the persisted patient control number');
  const adoptEvent = events.find((e) => e.statusTo === 'processing');
  assert.ok(adoptEvent && /reconcil/i.test(adoptEvent.note), 'adoption leaves a claim_events trail');
  assert.ok(acks.some((a) => a.kind === 'status' && a.controlNumber === PCN), 'reconciliation payload stored verbatim');
  assert.ok(audits.some((a) => a.action === 'claim.reconcile' && a.metadata.outcome === 'adopted'), 'reconciliation audited');

  // 5. RECONCILE NO-MATCH changes nothing: "not found" is inconclusive, never an
  //    invitation to resubmit.
  state.claim = { ...freshDraft(), status: 'submitted', control_number: null, patient_control_number: PCN, clearinghouse: 'stedi' };
  adapterState.reconcileResult = { found: false, raw: {} };
  res = await claims.handler(actionEvent('reconcile'));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(body(res).outcome, 'no_match');
  assert.strictEqual(state.claim.status, 'submitted', 'no-match leaves the claim blocked');
  res = await claims.handler(submitEvent());
  assert.strictEqual(res.statusCode, 409, 'and resubmission stays refused after a no-match');

  // 6. OPERATOR 'not_received' returns the claim to draft, and the resubmission
  //    REUSES the same patient control number so the clearinghouse can recognize
  //    a duplicate even if the operator judged wrong.
  res = await claims.handler(actionEvent('reconcile', { resolution: 'not_received' }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(body(res).outcome, 'reverted');
  assert.strictEqual(state.claim.status, 'draft', 'claim back to draft');
  assert.strictEqual(state.claim.patient_control_number, PCN, 'patient control number retained');
  adapterState.mode = 'ok';
  res = await claims.handler(submitEvent());
  assert.strictEqual(res.statusCode, 200, 'resubmission allowed after explicit not_received');
  assert.strictEqual(state.claim.patient_control_number, PCN, 'resubmission reused the SAME control number');
  assert.strictEqual(state.claim.control_number, 'CN-REAL', 'successful submit fills in the acknowledgment');
  assert.strictEqual(state.claim.status, 'submitted');

  // 7. RECONCILE refuses a claim that is not in the unknown state.
  res = await claims.handler(actionEvent('reconcile'));
  assert.strictEqual(res.statusCode, 409, 'a confirmed-submitted claim cannot be reconciled');

  // 8. OPERATOR 'received' requires the clearinghouse control number, then
  //    records it (this is the hand-reconcile path for the incident claim).
  state.claim = { ...freshDraft(), status: 'submitted', control_number: null, patient_control_number: PCN, clearinghouse: 'stedi' };
  res = await claims.handler(actionEvent('reconcile', { resolution: 'received' }));
  assert.strictEqual(res.statusCode, 400, "'received' without a control number is refused");
  res = await claims.handler(actionEvent('reconcile', { resolution: 'received', control_number: 'clm_01TEST' }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(body(res).outcome, 'adopted');
  assert.strictEqual(state.claim.control_number, 'clm_01TEST', 'operator-confirmed control number recorded');
  assert.strictEqual(state.claim.status, 'submitted');

  // 9. A structured clearinghouse REJECTION is a confirmed outcome: the claim
  //    returns to draft (fix and resubmit), never stuck in the unknown state.
  state.claim = { ...freshDraft(), patient_control_number: PCN };
  adapterState.mode = 'reject';
  res = await claims.handler(submitEvent());
  assert.strictEqual(res.statusCode, 422, 'rejection surfaces as 422 with the reason');
  assert.strictEqual(state.claim.status, 'draft', 'rejected claim returns to draft');
  assert.strictEqual(state.claim.control_number, null);

  // 10. Pure helpers: the unknown-state sentinel and the stedi control-number
  //     matcher (strict — a sibling claim for the same patient must not match).
  assert.strictEqual(claims.submissionOutcomeUnknown({ status: 'submitted', control_number: null }), true);
  assert.strictEqual(claims.submissionOutcomeUnknown({ status: 'submitted', control_number: 'CN' }), false);
  assert.strictEqual(claims.submissionOutcomeUnknown({ status: 'draft', control_number: null }), false);
  assert.strictEqual(claims.clearinghouseFailureClass(new Error('x timed out after 15000ms')), 'timeout');
  assert.strictEqual(claims.clearinghouseFailureClass(new Error('Stedi submission failed (HTTP 502)')), 'http_502');
  assert.strictEqual(claims.clearinghouseFailureClass(Object.assign(new Error('r'), { isRejection: true })), 'rejection');

  const stedi = require(path.join(__dirname, '..', 'lib', 'clearinghouse', 'stedi.js'));
  const statusData = {
    claims: [
      { claimStatus: { patientAccountNumber: 'OTHERCLAIM0000001', claimStatusCategoryCode: 'F1' } },
      { claimStatus: { patientAccountNumber: PCN, claimStatusCategoryCode: 'P1' } },
    ],
  };
  const matched = stedi.findStatusByPatientControlNumber(statusData, PCN);
  assert.ok(matched && matched.claimStatusCategoryCode === 'P1', 'matcher picks the entry echoing OUR control number');
  assert.strictEqual(
    stedi.findStatusByPatientControlNumber({ claims: [{ claimStatus: { patientAccountNumber: 'X1' } }] }, PCN),
    null,
    'a sibling claim for the same patient/week never matches'
  );

  console.error = origError;
  console.log = origLog;
  console.log('claim_submit_integrity.test.js: all assertions passed');
})().catch((err) => {
  console.error = origError;
  console.log = origLog;
  console.error(err);
  process.exit(1);
});
