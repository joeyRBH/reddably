'use strict';

// Unit test — 837P claim frequency (CLM05-3 / CMS-1500 Box 22) on the CLAIMS path.
//
// The builder used to hardcode claimFrequencyCode '1', so a resubmission of an
// already-accepted claim went out as a brand-new ORIGINAL with no reference to the
// payer's original claim — which payers reject as a duplicate. A REPLACEMENT
// (frequency 7) instead carries the payer's original claim control number so the
// payer replaces that specific claim (the clearinghouse translates it to REF*F8).
//
// This field is asymmetric and expensive to get wrong: a replacement sent as a new
// original ('1'), or without the reference, becomes another duplicate the payer
// rejects. So the assertions below are about DISCIPLINE, not just the happy path:
//
//   * an ordinary claim is byte-identical to before — '1', no reference field;
//   * a replacement sets '7' AND the reference, and NOTHING else changes;
//   * a frequency-7 claim with no payer claim number REFUSES to build (never a
//     silent downgrade to '1'); and
//   * anything carrying corrects_claim_id is treated as a replacement too, so a
//     half-populated row can't slip out as an original.
//
// Pure (no network, no DB).
//
//   node backend/tests/claim_replacement_frequency.test.js

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

// Build with an overridden claim (merged onto the base claim), returning the body.
const buildClaim = (claimOver) =>
  stedi.buildSubmissionBody({ ...base, claim: { ...base.claim, ...claimOver } }).body;

const PAYER_REF = 'ICN-2026-00099';

// --- 1. Ordinary claim: original '1', no reference field ----------------------

const ordinary = buildClaim({});
assert.strictEqual(
  ordinary.claimInformation.claimFrequencyCode,
  '1',
  'an ordinary claim is a frequency-1 original'
);
assert.ok(
  !Object.prototype.hasOwnProperty.call(ordinary.claimInformation, 'claimSupplementalInformation'),
  'an ordinary claim carries NO claimSupplementalInformation (the reference is omitted, not blanked)'
);

// The frequency column may arrive as undefined, null, '', or the explicit '1' —
// every one of these is an original and must build the SAME body as the baseline.
for (const code of [undefined, null, '', '1']) {
  const body = buildClaim({ submission_frequency_code: code });
  assert.deepStrictEqual(
    body,
    ordinary,
    `submission_frequency_code=${JSON.stringify(code)} builds a byte-identical original body`
  );
}

// --- 2. Replacement claim: '7' + the payer claim control number ---------------

const replacement = buildClaim({ submission_frequency_code: '7', payer_claim_control_number: PAYER_REF });
assert.strictEqual(
  replacement.claimInformation.claimFrequencyCode,
  '7',
  'a replacement claim is frequency 7'
);
assert.strictEqual(
  replacement.claimInformation.claimSupplementalInformation.claimControlNumber,
  PAYER_REF,
  "the payer's original claim number is on claimSupplementalInformation.claimControlNumber (→ REF*F8)"
);

// Surgical-diff: a replacement differs from the ordinary body ONLY by the frequency
// code and the added reference. Undo those two things and it must be byte-identical
// to the baseline — proof that nothing else (subscriber, service line, diagnoses)
// silently shifted.
// structuredClone (not JSON round-trip) so undefined-valued keys the builder emits
// — address2, employerId — survive the clone and the comparison stays apples-to-apples.
const undone = structuredClone(replacement);
undone.claimInformation.claimFrequencyCode = '1';
delete undone.claimInformation.claimSupplementalInformation;
assert.deepStrictEqual(
  undone,
  ordinary,
  'a replacement changes ONLY the frequency code and the reference — nothing else'
);

// --- 3. corrects_claim_id alone also means replacement ------------------------
// A row that references the claim it replaces is a replacement even if the
// frequency code is somehow unset — it must NOT be buildable as a new original.
assert.throws(
  () => buildClaim({ corrects_claim_id: 'a-claim-id' }),
  /payer claim control number/i,
  'a corrects_claim_id with no payer claim number refuses to build (never a silent original)'
);
const viaRef = buildClaim({ corrects_claim_id: 'a-claim-id', payer_claim_control_number: PAYER_REF });
assert.strictEqual(
  viaRef.claimInformation.claimFrequencyCode,
  '7',
  'corrects_claim_id + payer number builds a frequency-7 replacement'
);

// --- 4. Frequency 7 without the reference REFUSES to build --------------------
// The submit handler's safety gate rejects this first, but the builder is the last
// line of defense for any direct adapter caller: it throws rather than downgrade.
for (const missing of [undefined, null, '', '   ']) {
  assert.throws(
    () => buildClaim({ submission_frequency_code: '7', payer_claim_control_number: missing }),
    /payer claim control number|duplicate/i,
    `frequency 7 with payer_claim_control_number=${JSON.stringify(missing)} refuses to build`
  );
}

// --- 5. The reference is trimmed but never stripped/truncated -----------------
// Payer ICN/DCN values vary in format and length; unlike the 20-char CLM01 patient
// control number, we must not strip characters or truncate REF*F8.
const messy = buildClaim({ submission_frequency_code: '7', payer_claim_control_number: '  ABC-123/45.6  ' });
assert.strictEqual(
  messy.claimInformation.claimSupplementalInformation.claimControlNumber,
  'ABC-123/45.6',
  'the payer claim number is trimmed only — punctuation and length preserved'
);

// --- 6. isReplacementClaim in isolation --------------------------------------

assert.strictEqual(stedi.isReplacementClaim({ submission_frequency_code: '7' }), true, "'7' → replacement");
assert.strictEqual(stedi.isReplacementClaim({ corrects_claim_id: 'x' }), true, 'corrects_claim_id → replacement');
for (const code of [undefined, null, '', '1', '8', ' 1 ']) {
  assert.strictEqual(
    stedi.isReplacementClaim({ submission_frequency_code: code }),
    false,
    `submission_frequency_code=${JSON.stringify(code)} (no reference) is NOT a replacement`
  );
}
assert.strictEqual(stedi.isReplacementClaim(null), false, 'null claim is not a replacement');

console.log('claim_replacement_frequency.test.js: all assertions passed');
