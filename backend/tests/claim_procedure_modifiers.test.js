'use strict';

// Unit test — 837P procedure modifiers on the service line (buildSubmissionBody).
//
// Procedure modifiers (CMS-1500 Box 24D / 837P SV101-3..6) ride the service
// line's professionalService. The most important is 95 for synchronous
// telehealth, paired with a telehealth place of service. The session decides.
//
// The discipline these assertions enforce:
//   * present modifiers appear on professionalService, normalized (uppercase,
//     two-char, de-duplicated, stored order preserved) and capped at four;
//   * when the session carries NONE, the field is ABSENT from the built line —
//     not null, not '', not [] — so the wire body stays clean;
//   * the ordinary (no-modifier) claim body is structurally unchanged.
//
// Pure (no network, no DB).
//
//   node --test backend/tests/claim_procedure_modifiers.test.js

const assert = require('node:assert');
const path = require('node:path');

const stedi = require(path.join(__dirname, '..', 'lib', 'clearinghouse', 'stedi.js'));

const base = {
  claim: { id: '2f1c9a3e-7b4d-4c2a-9e11-abcdef012345', billed_amount: '150.00' },
  practice: {
    name: 'Test Practice',
    npi: '1234567890',
    address_line1: '1 Main St',
    city: 'Denver',
    state: 'CO',
    postal_code: '80202',
  },
  clinician: {},
  client: {
    first_name: 'Jamie',
    last_name: 'Rivera',
    date_of_birth: '2010-08-01',
    gender: 'female',
    address_line1: '5 Elm St',
    city: 'Denver',
    state: 'CO',
    postal_code: '80203',
  },
  session: { cpt_code: '90837', session_date: '2026-06-01', diagnosis_codes: ['F411'] },
  insurance: { payer_id: '60054', carrier_name: 'Aetna', member_id: 'W123456789' },
};

const build = (over) => stedi.buildSubmissionBody({ ...base, ...over }).body;
const withSession = (s) => build({ session: { ...base.session, ...s } });
const lineOf = (body) => body.claimInformation.serviceLines[0].professionalService;

// --- 0. REGRESSION: no modifiers → the field is absent from the service line ---
// The ordinary claim's professionalService is exactly what the pre-change builder
// produced. Assert it literally so a stray procedureModifiers key can't leak in.

assert.strictEqual(
  JSON.stringify(lineOf(build({}))),
  JSON.stringify({
    procedureIdentifier: 'HC',
    procedureCode: '90837',
    lineItemChargeAmount: '150.00',
    measurementUnit: 'UN',
    serviceUnitCount: '1',
    compositeDiagnosisCodePointers: { diagnosisCodePointers: ['1'] },
  }),
  'ordinary service line is byte-identical (no procedureModifiers key)'
);

// --- 1. Present: modifiers ride professionalService ---------------------------

assert.deepStrictEqual(
  lineOf(withSession({ procedure_modifiers: ['95'] })).procedureModifiers,
  ['95'],
  'a single 95 (synchronous telehealth) rides the service line'
);

assert.deepStrictEqual(
  lineOf(withSession({ procedure_modifiers: ['95', 'GT'] })).procedureModifiers,
  ['95', 'GT'],
  'multiple modifiers preserve stored order'
);

// --- 2. Normalization mirrors the handler -------------------------------------
// uppercase, strip punctuation to two alphanumerics, drop blanks, de-duplicate.

assert.deepStrictEqual(
  lineOf(withSession({ procedure_modifiers: ['95', ' gt ', '95', '', null, 'HJ'] })).procedureModifiers,
  ['95', 'GT', 'HJ'],
  'modifiers are trimmed, uppercased, blanks/dupes dropped, order preserved'
);

// --- 3. Defensive cap at four (SV101-3..6) ------------------------------------

assert.deepStrictEqual(
  lineOf(withSession({ procedure_modifiers: ['95', 'GT', '59', '76', '77'] })).procedureModifiers,
  ['95', 'GT', '59', '76'],
  'at most four modifiers reach the line even if more are somehow stored'
);

// --- 4. OMISSION: unset / all-blank → field ABSENT, not null / '' / [] ---------

for (const empty of [undefined, null, [], ['', '  '], ['x', '999', 'a-b'], 'not-an-array']) {
  const ps = lineOf(withSession({ procedure_modifiers: empty }));
  assert.ok(
    !('procedureModifiers' in ps),
    `no usable modifiers (${JSON.stringify(empty)}) → key absent from professionalService`
  );
}

// The same holds through JSON serialization — what actually goes on the wire.
const wire = JSON.parse(JSON.stringify(withSession({ procedure_modifiers: [] })));
assert.ok(
  !('procedureModifiers' in wire.claimInformation.serviceLines[0].professionalService),
  'no procedureModifiers key on the serialized wire body'
);

// --- 5. No service line at all when there is no CPT code ----------------------
// Modifiers are attached ONLY to a service line; with no CPT there is none, and a
// stored modifier cannot conjure one.

assert.ok(
  !('serviceLines' in build({ session: { session_date: '2026-06-01', procedure_modifiers: ['95'] } }).claimInformation),
  'a modifier without a CPT code does not fabricate a service line'
);

// --- 6. Modifiers are independent of the diagnosis pointers -------------------
// Both live on professionalService; setting one must not disturb the other.

const both = lineOf(withSession({
  diagnosis_codes: ['F411', 'F329'],
  procedure_modifiers: ['95'],
}));
assert.deepStrictEqual(both.compositeDiagnosisCodePointers.diagnosisCodePointers, ['1', '2'],
  'diagnosis pointers are unaffected by modifiers');
assert.deepStrictEqual(both.procedureModifiers, ['95'], 'modifiers are unaffected by diagnoses');

console.log('claim_procedure_modifiers.test.js: all assertions passed');
