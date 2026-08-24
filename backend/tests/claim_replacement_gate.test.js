'use strict';

// Unit test — the replacement-claim (CMS frequency 7) safety gate + the
// POST /claims/{id}/replace endpoint.
//
// A replacement asks the payer to REPLACE a claim it previously accepted. Getting
// it wrong files another duplicate the payer rejects, so the handler NEVER silently
// downgrades a replacement to a new original ('1'): every bad case is a hard reject
// and the clearinghouse is not called. This test pins that down, mirroring the
// require-cache mock approach of claim_test_submission_gate.test.js — nothing here
// touches a database or the network.
//
// It covers, on POST /claims/{id}/submit for a replacement draft:
//   * missing payer claim number            → 422, no submit
//   * original was never transmitted         → 422, no submit
//   * original not in an accepted state      → 422, no submit
//   * a replacement was already submitted    → 409, no submit
//   * valid but unconfirmed                  → requires_confirmation (payer # shown), no submit
//   * valid + confirmed                      → 200, submits as frequency 7
// and on POST /claims/{id}/replace:
//   * original not payer-accepted            → 409
//   * missing payer claim number             → 400
//   * a replacement already exists           → 409
//   * happy path                             → 201, creates the replacement draft
//
//   node backend/tests/claim_replacement_gate.test.js

const assert = require('node:assert');
const path = require('node:path');

function mock(rel, exports) {
  const resolved = require.resolve(path.join(__dirname, '..', rel));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const PRACTICE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const ORIGINAL_ID = '2f1c9a3e-7b4d-4c2a-9e11-abcdef012345';
const REPL_ID = '9a9a9a9a-1b2c-4d3e-8f40-abcdef010203';
const PAYER_REF = 'ICN-2026-00099';

// Context rows for buildClaimContext + the pre-submission guards (billing address
// present, subscriber DOB present, non-dependent) — same shape as the sibling gate test.
const CTX = {
  sessions: { id: 's1', cpt_code: '90837', session_date: '2026-06-01', diagnosis_codes: ['F411'] },
  clients: {
    id: 'c1', first_name: 'Jamie', last_name: 'Rivera', date_of_birth: '2010-08-01',
    gender: 'female', address_line1: '5 Elm St', city: 'Denver', state: 'CO', postal_code: '80203',
  },
  users_clinician: { id: USER_ID, practice_id: PRACTICE_ID, first_name: 'Dana', last_name: 'Cruz', npi: '1987654320' },
  practices: {
    id: PRACTICE_ID, name: 'Test Practice', npi: '1234567890', tax_id: '123456789',
    address_line1: '1 Main St', city: 'Denver', state: 'CO', postal_code: '80202',
  },
  insurance_records: { id: 'i1', payer_id: '60054', carrier_name: 'Aetna', member_id: 'W123456789' },
};

function claimRow(over) {
  return {
    id: REPL_ID, practice_id: PRACTICE_ID, status: 'draft', billed_amount: '150.00',
    session_id: 's1', client_id: 'c1', clinician_id: USER_ID, insurance_record_id: 'i1',
    claim_number: null, control_number: null, patient_control_number: null,
    submission_frequency_code: null, payer_claim_control_number: null, corrects_claim_id: null,
    ...over,
  };
}

// Mutable per-case state driving the mocked DB.
const state = {
  byId: {},                 // claim id -> row, for loadClaim
  priorSubmittedReplacement: false,   // submit gate: another replacement already submitted
  existingReplacement: false,         // /replace: a replacement already exists
};

mock('lib/db.js', {
  query: async (sql, params) => {
    if (/select practice_id from users/i.test(sql)) {
      return { rows: [{ practice_id: PRACTICE_ID }], rowCount: 1 };
    }
    // The two guarded claims sub-queries must be matched BEFORE the generic
    // loadClaim (which selects * ... where id = $1) — both filter on corrects_claim_id.
    if (/corrects_claim_id/i.test(sql) && /control_number is not null/i.test(sql)) {
      return { rows: [], rowCount: state.priorSubmittedReplacement ? 1 : 0 };
    }
    if (/corrects_claim_id/i.test(sql) && /status <> 'void'/i.test(sql)) {
      return { rows: [], rowCount: state.existingReplacement ? 1 : 0 };
    }
    if (/from claims\b/i.test(sql)) {
      const row = state.byId[params && params[0]] || null;
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (/from sessions\b/i.test(sql)) return { rows: [CTX.sessions], rowCount: 1 };
    if (/from clients\b/i.test(sql)) return { rows: [CTX.clients], rowCount: 1 };
    if (/from users\b/i.test(sql)) return { rows: [CTX.users_clinician], rowCount: 1 };
    if (/from practices\b/i.test(sql)) return { rows: [CTX.practices], rowCount: 1 };
    if (/from provider_billing_profiles\b/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/from insurance_records\b/i.test(sql)) return { rows: [CTX.insurance_records], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  },
  // Submit's UPDATE returns the submitted row; /replace ignores the client (its
  // insert goes through the mocked insertReplacementClaim below).
  withTransaction: async (fn) => fn({
    query: async () => ({
      rows: [claimRow({ status: 'submitted', control_number: 'CN-NEW', submission_frequency_code: '7',
        corrects_claim_id: ORIGINAL_ID, payer_claim_control_number: PAYER_REF })],
      rowCount: 1,
    }),
  }),
});

mock('lib/audit.js', { audit: async () => {}, sanitizeFields: (x) => x });

const claimsLibSpy = { insertCalls: 0, lastInsertOpts: null };
mock('lib/claims.js', {
  // [] makes buildClaimContext fall back to the anchor session, so these cases
  // stay exactly the single-service-line claims they were written to test.
  loadClaimSessions: async () => [],
  insertGroupedClaim: async () => ({}),
  primaryInsuranceForClient: async () => CTX.insurance_records,
  logClaimEvent: async () => {},
  logClaimAcknowledgment: async () => {},
  insertDraftClaim: async () => ({}),
  ensurePatientControlNumber: async () => 'PCN123',
  insertReplacementClaim: async (_q, opts) => {
    claimsLibSpy.insertCalls += 1;
    claimsLibSpy.lastInsertOpts = opts;
    return claimRow({
      id: REPL_ID, status: 'draft', submission_frequency_code: '7',
      payer_claim_control_number: opts.payerClaimControlNumber, corrects_claim_id: opts.original.id,
    });
  },
});

mock('lib/auth.js', {
  requireAuth: () => ({ user: { sub: USER_ID, practice_id: PRACTICE_ID, role: 'practice_admin' } }),
  AuthError: class AuthError extends Error {},
});

const adapterSpy = { calls: 0, lastCtx: null };
mock('lib/clearinghouse/index.js', {
  getClearinghouse: () => ({
    name: 'stedi',
    submitClaim: async (ctx) => {
      adapterSpy.calls += 1;
      adapterSpy.lastCtx = ctx;
      return { control_number: 'CN-NEW', claim_number: 'CN-NEW', status: 'submitted', raw: { adapter: 'stedi' } };
    },
  }),
});

const claims = require(path.join(__dirname, '..', 'handlers', 'claims.js'));

function reset() {
  state.byId = {};
  state.priorSubmittedReplacement = false;
  state.existingReplacement = false;
  adapterSpy.calls = 0;
  adapterSpy.lastCtx = null;
  claimsLibSpy.insertCalls = 0;
  claimsLibSpy.lastInsertOpts = null;
}

const submitEvent = (id, body) => ({
  requestContext: { http: { method: 'POST' }, routeKey: 'POST /claims/{id}/submit' },
  pathParameters: { id },
  headers: { authorization: 'Bearer x' },
  body: JSON.stringify(body || {}),
});

const replaceEvent = (id, body) => ({
  requestContext: { http: { method: 'POST' }, routeKey: 'POST /claims/{id}/replace' },
  pathParameters: { id },
  headers: { authorization: 'Bearer x' },
  body: JSON.stringify(body || {}),
});

// An accepted original a replacement can legitimately point at.
const acceptedOriginal = () => claimRow({
  id: ORIGINAL_ID, status: 'paid', control_number: 'CN-ORIG',
  submission_frequency_code: '1',
});

(async () => {
  // ===== POST /claims/{id}/submit — the safety gate ==========================

  // A) Replacement draft missing the payer claim number → 422, never submitted.
  reset();
  state.byId[REPL_ID] = claimRow({ submission_frequency_code: '7', corrects_claim_id: ORIGINAL_ID, payer_claim_control_number: null });
  state.byId[ORIGINAL_ID] = acceptedOriginal();
  let res = await claims.handler(submitEvent(REPL_ID, { confirmed: true }));
  assert.strictEqual(res.statusCode, 422, 'A) missing payer claim number is rejected');
  assert.strictEqual(adapterSpy.calls, 0, 'A) and is never sent as a new original');

  // B) Original was never successfully transmitted (no control number) → 422.
  reset();
  state.byId[REPL_ID] = claimRow({ submission_frequency_code: '7', corrects_claim_id: ORIGINAL_ID, payer_claim_control_number: PAYER_REF });
  state.byId[ORIGINAL_ID] = claimRow({ id: ORIGINAL_ID, status: 'paid', control_number: null });
  res = await claims.handler(submitEvent(REPL_ID, { confirmed: true }));
  assert.strictEqual(res.statusCode, 422, 'B) an untransmitted original cannot be replaced');
  assert.strictEqual(adapterSpy.calls, 0, 'B) and nothing is submitted');

  // C) Original is not in an accepted lifecycle state (still a draft) → 422.
  reset();
  state.byId[REPL_ID] = claimRow({ submission_frequency_code: '7', corrects_claim_id: ORIGINAL_ID, payer_claim_control_number: PAYER_REF });
  state.byId[ORIGINAL_ID] = claimRow({ id: ORIGINAL_ID, status: 'draft', control_number: 'CN-ORIG' });
  res = await claims.handler(submitEvent(REPL_ID, { confirmed: true }));
  assert.strictEqual(res.statusCode, 422, 'C) a never-accepted original cannot be replaced');
  assert.strictEqual(adapterSpy.calls, 0, 'C) and nothing is submitted');

  // D) A replacement of this original was already submitted → 409, no duplicate.
  reset();
  state.byId[REPL_ID] = claimRow({ submission_frequency_code: '7', corrects_claim_id: ORIGINAL_ID, payer_claim_control_number: PAYER_REF });
  state.byId[ORIGINAL_ID] = acceptedOriginal();
  state.priorSubmittedReplacement = true;
  res = await claims.handler(submitEvent(REPL_ID, { confirmed: true }));
  assert.strictEqual(res.statusCode, 409, 'D) a second replacement of the same claim is refused');
  assert.strictEqual(adapterSpy.calls, 0, 'D) and nothing is submitted');

  // E) Valid replacement, NOT confirmed → held for confirmation, payer # surfaced.
  reset();
  state.byId[REPL_ID] = claimRow({ submission_frequency_code: '7', corrects_claim_id: ORIGINAL_ID, payer_claim_control_number: PAYER_REF });
  state.byId[ORIGINAL_ID] = acceptedOriginal();
  res = await claims.handler(submitEvent(REPL_ID, {}));
  assert.strictEqual(res.statusCode, 200, 'E) unconfirmed replacement returns a 200 confirmation hold');
  let payload = JSON.parse(res.body);
  assert.strictEqual(payload.requires_confirmation, true, 'E) it requires confirmation');
  const replWarn = (payload.warnings || []).find((w) => w.code === 'replacement_claim');
  assert.ok(replWarn, 'E) a replacement_claim warning is present');
  assert.strictEqual(replWarn.payer_claim_control_number, PAYER_REF, 'E) the payer claim number is shown for confirmation');
  assert.match(replWarn.message, /previously accepted/i, 'E) the message explains it replaces an accepted claim');
  assert.strictEqual(adapterSpy.calls, 0, 'E) nothing is submitted before confirmation');

  // F) Valid replacement, confirmed → submits, and the ctx carries frequency 7 so
  //    the builder emits a replacement (proven byte-for-byte in the builder test).
  reset();
  state.byId[REPL_ID] = claimRow({ submission_frequency_code: '7', corrects_claim_id: ORIGINAL_ID, payer_claim_control_number: PAYER_REF });
  state.byId[ORIGINAL_ID] = acceptedOriginal();
  res = await claims.handler(submitEvent(REPL_ID, { confirmed: true }));
  assert.strictEqual(res.statusCode, 200, 'F) a confirmed valid replacement submits');
  assert.strictEqual(adapterSpy.calls, 1, 'F) and reaches the clearinghouse exactly once');
  assert.strictEqual(adapterSpy.lastCtx.claim.submission_frequency_code, '7', 'F) the ctx claim is frequency 7');
  assert.strictEqual(adapterSpy.lastCtx.claim.payer_claim_control_number, PAYER_REF, 'F) the ctx carries the payer claim number');
  payload = JSON.parse(res.body);
  assert.strictEqual(payload.claim.status, 'submitted', 'F) the claim is now submitted');

  // Control: an ordinary (non-replacement) draft is unaffected by the gate.
  reset();
  state.byId[REPL_ID] = claimRow({});  // no frequency, no reference
  res = await claims.handler(submitEvent(REPL_ID, { confirmed: true }));
  assert.strictEqual(res.statusCode, 200, 'control: an ordinary claim still submits');
  assert.strictEqual(adapterSpy.calls, 1, 'control: reaches the clearinghouse');
  assert.strictEqual(adapterSpy.lastCtx.claim.submission_frequency_code, null, 'control: not a replacement');

  // ===== POST /claims/{id}/replace — create a replacement draft ==============

  // G) The claim being replaced is not payer-accepted (a draft) → 409.
  reset();
  state.byId[ORIGINAL_ID] = claimRow({ id: ORIGINAL_ID, status: 'draft', control_number: null });
  res = await claims.handler(replaceEvent(ORIGINAL_ID, { payer_claim_control_number: PAYER_REF }));
  assert.strictEqual(res.statusCode, 409, 'G) only an accepted claim can be replaced');
  assert.strictEqual(claimsLibSpy.insertCalls, 0, 'G) no replacement draft is created');

  // H) Accepted original, but no payer claim number provided → 400.
  reset();
  state.byId[ORIGINAL_ID] = acceptedOriginal();
  res = await claims.handler(replaceEvent(ORIGINAL_ID, {}));
  assert.strictEqual(res.statusCode, 400, 'H) the payer claim number is required');
  assert.strictEqual(claimsLibSpy.insertCalls, 0, 'H) no replacement draft is created');

  // I) Accepted original, but a replacement already exists → 409.
  reset();
  state.byId[ORIGINAL_ID] = acceptedOriginal();
  state.existingReplacement = true;
  res = await claims.handler(replaceEvent(ORIGINAL_ID, { payer_claim_control_number: PAYER_REF }));
  assert.strictEqual(res.statusCode, 409, 'I) a duplicate replacement is refused');
  assert.strictEqual(claimsLibSpy.insertCalls, 0, 'I) no second replacement draft is created');

  // J) Happy path → 201 with a frequency-7 replacement draft.
  reset();
  state.byId[ORIGINAL_ID] = acceptedOriginal();
  res = await claims.handler(replaceEvent(ORIGINAL_ID, { payer_claim_control_number: PAYER_REF }));
  assert.strictEqual(res.statusCode, 201, 'J) a replacement draft is created');
  assert.strictEqual(claimsLibSpy.insertCalls, 1, 'J) exactly one replacement draft');
  assert.strictEqual(claimsLibSpy.lastInsertOpts.payerClaimControlNumber, PAYER_REF, 'J) it carries the payer claim number');
  assert.strictEqual(claimsLibSpy.lastInsertOpts.original.id, ORIGINAL_ID, 'J) it references the original');
  payload = JSON.parse(res.body);
  assert.strictEqual(payload.claim.submission_frequency_code, '7', 'J) the new draft is frequency 7');
  assert.strictEqual(payload.claim.corrects_claim_id, ORIGINAL_ID, 'J) the new draft references the original');

  console.log('claim_replacement_gate.test.js: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
