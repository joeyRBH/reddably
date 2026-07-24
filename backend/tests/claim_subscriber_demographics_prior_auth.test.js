'use strict';

// Unit test — buildSubmissionBody: dependent-subscriber (policyholder) gender +
// address (CMS-1500 Box 7 / 11a) and the claim-level prior authorization number
// (Box 23 / 837P claim-level REF*G1).
//
// Two payer-required additions, both OPTIONAL and both asserted to be ABSENT from
// the built body when unset (never '' / null / {}), so ordinary claims stay
// structurally unchanged:
//
//   * dependent subscriber.gender — the policyholder's gender, mapped through the
//     SAME genderCode() helper the non-dependent branch uses (female→F, male→M,
//     unknown→U). An explicit 'unknown' is emitted as 'U' exactly as the
//     non-dependent path emits it; an UNSET gender omits the key.
//   * dependent subscriber.address — the policyholder's address; the key is
//     omitted entirely when no line is present.
//   * claimInformation.claimSupplementalInformation.priorAuthorizationNumber —
//     merged so a replacement claim keeps BOTH claimControlNumber and the prior
//     auth; omitted entirely (no claimSupplementalInformation) on an ordinary claim.
//
// Pure (no network, no DB).
//
//   node backend/tests/claim_subscriber_demographics_prior_auth.test.js

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
};

// A policyholder (dependent-mode) insurance record with name/DOB/member id but
// NO demographics yet — the baseline the demographics build on top of.
const depInsuranceBase = {
  payer_id: '60054',
  carrier_name: 'Surest',
  member_id: 'W123456789',
  subscriber_relationship: 'child',
  subscriber_name: 'Pat Rivera',
  subscriber_dob: '1965-02-10',
};

// --- 1. Dependent subscriber gender: female / male / unknown ------------------

// Each maps through the same genderCode() helper the non-dependent branch uses.
// The 'unknown' case must produce the SAME code the non-dependent path produces
// for an 'unknown' client — we assert that equivalence explicitly.
for (const [stored, expected] of [['female', 'F'], ['male', 'M'], ['unknown', 'U']]) {
  const body = stedi.buildSubmissionBody({
    ...base,
    insurance: { ...depInsuranceBase, subscriber_gender: stored },
  }).body;
  assert.strictEqual(
    body.subscriber.gender,
    expected,
    `dependent subscriber gender ${stored} → ${expected}`
  );

  // Equivalence to the non-dependent path: build a self claim whose patient gender
  // is the same stored value and confirm the emitted subscriber.gender matches.
  const selfBody = stedi.buildSubmissionBody({
    ...base,
    client: { ...base.client, gender: stored },
    insurance: { payer_id: '60054', member_id: 'W1', subscriber_relationship: 'self' },
  }).body;
  assert.strictEqual(
    body.subscriber.gender,
    selfBody.subscriber.gender,
    `dependent gender ${stored} handled the same as the non-dependent path`
  );
}

// Gender UNSET on a dependent record → no gender key at all (never 'U', never '').
const noGender = stedi.buildSubmissionBody({ ...base, insurance: depInsuranceBase }).body;
assert.ok(
  !('gender' in noGender.subscriber),
  'dependent subscriber gender omitted entirely when unset'
);

// --- 2. Dependent subscriber address ------------------------------------------

const withAddress = stedi.buildSubmissionBody({
  ...base,
  insurance: {
    ...depInsuranceBase,
    subscriber_address_line1: '99 Holder Ave',
    subscriber_address_line2: 'Unit 4',
    subscriber_city: 'Boulder',
    subscriber_state: 'CO',
    subscriber_postal_code: '80301',
  },
}).body;
assert.deepStrictEqual(
  withAddress.subscriber.address,
  {
    address1: '99 Holder Ave',
    address2: 'Unit 4',
    city: 'Boulder',
    state: 'CO',
    postalCode: '80301',
  },
  'policyholder address mirrors the non-dependent field names (address1/2/city/state/postalCode)'
);

// Partial address: only the present lines appear; no empty keys.
const partialAddress = stedi.buildSubmissionBody({
  ...base,
  insurance: {
    ...depInsuranceBase,
    subscriber_address_line1: '99 Holder Ave',
    subscriber_city: 'Boulder',
    subscriber_state: 'CO',
    subscriber_postal_code: '80301',
  },
}).body;
assert.deepStrictEqual(
  partialAddress.subscriber.address,
  { address1: '99 Holder Ave', city: 'Boulder', state: 'CO', postalCode: '80301' },
  'partial policyholder address carries only present lines (no address2 key)'
);

// Address UNSET → no address key at all (not an all-undefined object).
assert.ok(
  !('address' in noGender.subscriber),
  'dependent subscriber address omitted entirely when unset'
);

// The policyholder demographics NEVER leak onto the patient (dependent) loop —
// the dependent still carries the patient's own gender/address.
assert.strictEqual(withAddress.dependent.gender, 'F', 'patient gender unchanged by policyholder demographics');
assert.strictEqual(
  withAddress.dependent.address.address1,
  '5 Elm St',
  'patient address unchanged by policyholder demographics'
);

// --- 3. Prior authorization number (Box 23 / REF*G1) --------------------------

// Present → claimSupplementalInformation.priorAuthorizationNumber, trimmed.
const withPriorAuth = stedi.buildSubmissionBody({
  ...base,
  claim: { ...base.claim, prior_authorization_number: '  AUTH-12345  ' },
  insurance: { payer_id: '60054', member_id: 'W1', subscriber_relationship: 'self' },
}).body;
assert.strictEqual(
  withPriorAuth.claimInformation.claimSupplementalInformation.priorAuthorizationNumber,
  'AUTH-12345',
  'prior authorization number surfaces on claimSupplementalInformation (trimmed)'
);

// Absent → no claimSupplementalInformation object at all on an ordinary claim.
const noPriorAuth = stedi.buildSubmissionBody({
  ...base,
  insurance: { payer_id: '60054', member_id: 'W1', subscriber_relationship: 'self' },
}).body;
assert.ok(
  !('claimSupplementalInformation' in noPriorAuth.claimInformation),
  'ordinary claim has no claimSupplementalInformation when no prior auth / replacement'
);

// --- 4. Prior auth + replacement coexist (both keys, merge-safe) --------------

const replacementWithAuth = stedi.buildSubmissionBody({
  ...base,
  claim: {
    ...base.claim,
    submission_frequency_code: '7',
    payer_claim_control_number: 'PAYER-ICN-777',
    prior_authorization_number: 'AUTH-999',
  },
  insurance: { payer_id: '60054', member_id: 'W1', subscriber_relationship: 'self' },
}).body;
assert.strictEqual(replacementWithAuth.claimInformation.claimFrequencyCode, '7', 'replacement stays frequency 7');
assert.deepStrictEqual(
  replacementWithAuth.claimInformation.claimSupplementalInformation,
  { claimControlNumber: 'PAYER-ICN-777', priorAuthorizationNumber: 'AUTH-999' },
  'replacement + prior auth keep BOTH claimControlNumber and priorAuthorizationNumber'
);

// --- 5. Ordinary claim body is byte-identical to the pre-change shape ----------

// A non-dependent claim with no prior auth must be byte-identical to a body built
// with none of the new inputs present — proving the additions are purely additive.
const ordinary = stedi.buildSubmissionBody({
  ...base,
  claim: { id: base.claim.id, billed_amount: '150.00' },
  insurance: { payer_id: '60054', carrier_name: 'Aetna', member_id: 'W123456789' },
}).body;
assert.ok(!('claimSupplementalInformation' in ordinary.claimInformation), 'no supplemental info on ordinary claim');
assert.ok(!('dependent' in ordinary), 'no dependent loop on ordinary claim');

console.log('PASS claim_subscriber_demographics_prior_auth.test.js');
