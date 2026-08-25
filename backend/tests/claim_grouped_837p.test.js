'use strict';

// Unit test — the 837P body for a GROUPED claim (one filing, several dates of
// service): backend/lib/clearinghouse/stedi.js buildSubmissionBody.
//
// MONEY-PATH. Two properties matter more than anything else here:
//
// 1. ONE LINE PER SESSION, each with its OWN service date and charge, taken from
//    the STORED line charge rather than the session's current fee — so editing a
//    session after filing cannot make the filed lines stop adding up.
//
// 2. THE LINE-SUM INVARIANT. A payer rejects an 837P whose service lines do not
//    sum to the claim charge, and that rejection arrives days later against a
//    real filing on a real patient's coverage. The builder asserts it in whole
//    cents and refuses to build on a mismatch, so it surfaces here — while the
//    claim is still a draft inside our own process.
//
// Also pinned: a single-line claim builds EXACTLY as it did before service lines
// existed. That regression guard is the reason grouping could be added without
// touching every claim already in flight.
//
//   node backend/tests/claim_grouped_837p.test.js

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
    date_of_birth: '1990-08-01',
    gender: 'female',
    address_line1: '5 Elm St',
    city: 'Denver',
    state: 'CO',
    postal_code: '80203',
  },
  session: { cpt_code: '90837', session_date: '2026-06-01', diagnosis_codes: ['F411'] },
  insurance: { payer_id: '60054', carrier_name: 'Aetna', member_id: 'W123456789' },
};

function line(over) {
  return Object.assign({
    id: 'session-1',
    cpt_code: '90837',
    session_date: '2026-06-01',
    diagnosis_codes: ['F411'],
    place_of_service: '10',
    line_charge: '150.00',
  }, over || {});
}

const build = (over) => stedi.buildSubmissionBody(Object.assign({}, base, over)).body;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- 1. the single-line claim is untouched ------------------------------------

test('a claim with no ctx.sessions builds exactly one line, as before', () => {
  const body = build({});
  const lines = body.claimInformation.serviceLines;
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].serviceDate, '20260601');
  assert.strictEqual(lines[0].professionalService.lineItemChargeAmount, '150.00',
    'falls back to the claim charge, exactly as it did before service lines');
});

test('a single-element ctx.sessions is identical to no ctx.sessions', () => {
  const withoutLines = JSON.stringify(build({}).claimInformation.serviceLines);
  const withLines = JSON.stringify(
    build({ sessions: [line()] }).claimInformation.serviceLines
  );
  assert.strictEqual(withLines, withoutLines,
    'adding the lines relationship changed nothing for a 1:1 claim');
});

// --- 2. a grouped claim -------------------------------------------------------

test('three sessions produce three dated service lines', () => {
  const body = build({
    claim: { id: base.claim.id, billed_amount: '450.00' },
    sessions: [
      line({ id: 's1', session_date: '2026-06-01', line_charge: '150.00' }),
      line({ id: 's2', session_date: '2026-06-08', line_charge: '150.00' }),
      line({ id: 's3', session_date: '2026-06-15', line_charge: '150.00' }),
    ],
  });
  const lines = body.claimInformation.serviceLines;

  assert.strictEqual(lines.length, 3, 'one line per session');
  assert.deepStrictEqual(lines.map((l) => l.serviceDate),
    ['20260601', '20260608', '20260615'], 'each line carries its OWN date');
  assert.deepStrictEqual(lines.map((l) => l.professionalService.lineItemChargeAmount),
    ['150.00', '150.00', '150.00'], 'each line carries its OWN charge');
  assert.strictEqual(body.claimInformation.claimChargeAmount, '450.00',
    'the claim charge is the sum');
});

test('lines may differ in code, charge and modifiers', () => {
  const body = build({
    claim: { id: base.claim.id, billed_amount: '275.00' },
    sessions: [
      line({ id: 's1', cpt_code: '90791', line_charge: '175.00', procedure_modifiers: ['95'] }),
      line({ id: 's2', cpt_code: '90834', line_charge: '100.00', session_date: '2026-06-08' }),
    ],
  });
  const lines = body.claimInformation.serviceLines;

  assert.strictEqual(lines[0].professionalService.procedureCode, '90791');
  assert.deepStrictEqual(lines[0].professionalService.procedureModifiers, ['95']);
  assert.strictEqual(lines[1].professionalService.procedureCode, '90834');
  assert.ok(!('procedureModifiers' in lines[1].professionalService),
    'a line with no modifiers omits the field entirely, never sends []');
});

test('the STORED line charge wins over the session fee', () => {
  // The session was edited to 999 after the claim was built. The filed lines must
  // still be what was filed, or they stop summing to the filed claim total.
  const body = build({
    claim: { id: base.claim.id, billed_amount: '300.00' },
    sessions: [
      line({ id: 's1', line_charge: '150.00', fee: '999.00' }),
      line({ id: 's2', line_charge: '150.00', fee: '999.00', session_date: '2026-06-08' }),
    ],
  });
  assert.deepStrictEqual(
    body.claimInformation.serviceLines.map((l) => l.professionalService.lineItemChargeAmount),
    ['150.00', '150.00']
  );
});

// --- 3. THE LINE-SUM INVARIANT ------------------------------------------------

test('a claim charge that does not equal the line sum REFUSES to build', () => {
  assert.throws(() => build({
    claim: { id: base.claim.id, billed_amount: '500.00' },   // lines total 300
    sessions: [
      line({ id: 's1', line_charge: '150.00' }),
      line({ id: 's2', line_charge: '150.00', session_date: '2026-06-08' }),
    ],
  }), /does not equal the sum of its service lines/i,
  'the payer would reject this days later, against a real filing');
});

test('the refusal names both totals, so the operator can see the gap', () => {
  try {
    build({
      claim: { id: base.claim.id, billed_amount: '500.00' },
      sessions: [line({ id: 's1', line_charge: '150.00' }),
        line({ id: 's2', line_charge: '150.00', session_date: '2026-06-08' })],
    });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(/claim 500/.test(err.message), 'names the claim charge');
    assert.ok(/lines 300/.test(err.message), 'names the line total');
  }
});

test('cent-level sums that float arithmetic would break still build', () => {
  // 3 x 116.66 = 349.98, but naive float addition gives 349.98000000000005.
  // Comparing in whole cents is what keeps this from being a false refusal on a
  // perfectly correct claim.
  const body = build({
    claim: { id: base.claim.id, billed_amount: '349.98' },
    sessions: [
      line({ id: 's1', line_charge: '116.66' }),
      line({ id: 's2', line_charge: '116.66', session_date: '2026-06-08' }),
      line({ id: 's3', line_charge: '116.66', session_date: '2026-06-15' }),
    ],
  });
  assert.strictEqual(body.claimInformation.serviceLines.length, 3);
});

test('a session with no CPT code contributes no line', () => {
  // Unchanged behaviour: the builder only ever emitted a line for a coded
  // session. The submit gate blocks this case first; the builder stays honest.
  const body = build({
    claim: { id: base.claim.id, billed_amount: '150.00' },
    sessions: [
      line({ id: 's1', line_charge: '150.00' }),
      line({ id: 's2', cpt_code: null, line_charge: null, session_date: '2026-06-08' }),
    ],
  });
  assert.strictEqual(body.claimInformation.serviceLines.length, 1);
});

// --- 4. claim-level fields still come from the anchor -------------------------

test('place of service and diagnoses stay CLAIM-level', () => {
  // This is exactly why grouping refuses to combine claims that disagree about
  // them: the 837P has one of each per claim, so a mismatch would not split the
  // claim, it would file both services under one value.
  const body = build({
    claim: { id: base.claim.id, billed_amount: '300.00' },
    session: { cpt_code: '90837', session_date: '2026-06-01', diagnosis_codes: ['F411'], place_of_service: '10' },
    sessions: [
      line({ id: 's1', line_charge: '150.00' }),
      line({ id: 's2', line_charge: '150.00', session_date: '2026-06-08' }),
    ],
  });
  assert.strictEqual(body.claimInformation.placeOfServiceCode, '10',
    'one place of service for the whole claim');
  assert.strictEqual(body.claimInformation.healthCareCodeInformation.length, 1,
    'one diagnosis set for the whole claim');
});

// --- 5. line semantics: order, units, and diagnosis pointers ------------------

test('service lines are emitted in deterministic date-of-service order', () => {
  // The order is fixed at grouping time (claim_sessions.position, assigned in
  // date order) and read back by position, so a resubmission emits the same
  // sequence and the 277CA/835 line references still align.
  const body = build({
    claim: { id: base.claim.id, billed_amount: '450.00' },
    sessions: [
      line({ id: 's1', session_date: '2026-06-01', line_charge: '150.00' }),
      line({ id: 's2', session_date: '2026-06-08', line_charge: '150.00' }),
      line({ id: 's3', session_date: '2026-06-15', line_charge: '150.00' }),
    ],
  });
  assert.deepStrictEqual(
    body.claimInformation.serviceLines.map((l) => l.serviceDate),
    ['20260601', '20260608', '20260615']
  );
  // And it is a function of the input order alone — same input, same output.
  const again = build({
    claim: { id: base.claim.id, billed_amount: '450.00' },
    sessions: [
      line({ id: 's1', session_date: '2026-06-01', line_charge: '150.00' }),
      line({ id: 's2', session_date: '2026-06-08', line_charge: '150.00' }),
      line({ id: 's3', session_date: '2026-06-15', line_charge: '150.00' }),
    ],
  });
  assert.strictEqual(JSON.stringify(again.claimInformation.serviceLines),
    JSON.stringify(body.claimInformation.serviceLines), 'deterministic');
});

test('every line carries its own units, and one unit each', () => {
  const body = build({
    claim: { id: base.claim.id, billed_amount: '300.00' },
    sessions: [line({ id: 's1', line_charge: '150.00' }),
      line({ id: 's2', line_charge: '150.00', session_date: '2026-06-08' })],
  });
  body.claimInformation.serviceLines.forEach((l, i) => {
    assert.strictEqual(l.professionalService.measurementUnit, 'UN', 'line ' + i);
    assert.strictEqual(l.professionalService.serviceUnitCount, '1', 'line ' + i);
    assert.strictEqual(l.professionalService.procedureIdentifier, 'HC', 'line ' + i);
  });
});

test('diagnosis pointers on EVERY line resolve to a real claim-level diagnosis', () => {
  // Diagnoses live at the CLAIM level; each line points into that list by
  // 1-based index. A pointer past the end of the list is an 837P the payer
  // rejects, so every pointer on every line is checked against the emitted set.
  const body = build({
    claim: { id: base.claim.id, billed_amount: '450.00' },
    session: {
      cpt_code: '90837', session_date: '2026-06-01',
      diagnosis_codes: ['F411', 'F321', 'F331'],
    },
    sessions: [
      line({ id: 's1', line_charge: '150.00' }),
      line({ id: 's2', line_charge: '150.00', session_date: '2026-06-08' }),
      line({ id: 's3', line_charge: '150.00', session_date: '2026-06-15' }),
    ],
  });

  const claimDx = body.claimInformation.healthCareCodeInformation;
  assert.strictEqual(claimDx.length, 3, 'the shared set is emitted once, at claim level');
  assert.strictEqual(claimDx[0].diagnosisTypeCode, 'ABK', 'first is the principal');
  assert.ok(claimDx.slice(1).every((d) => d.diagnosisTypeCode === 'ABF'), 'the rest are secondary');

  body.claimInformation.serviceLines.forEach((l, i) => {
    const pointers = l.professionalService.compositeDiagnosisCodePointers.diagnosisCodePointers;
    assert.ok(pointers.length > 0, 'line ' + i + ' points at something');
    pointers.forEach((ptr) => {
      const idx = Number(ptr);
      assert.ok(Number.isInteger(idx) && idx >= 1 && idx <= claimDx.length,
        'line ' + i + ' pointer ' + ptr + ' is within the claim diagnosis list (1..' + claimDx.length + ')');
    });
  });
});

test('pointers stay within the LINE limit even with many claim diagnoses', () => {
  // The claim allows 12 diagnoses; a service line allows only 4 pointers (SV107).
  // Emitting one pointer per claim diagnosis would overflow the segment.
  const many = ['F411', 'F321', 'F331', 'F401', 'F431', 'F500'];
  const body = build({
    claim: { id: base.claim.id, billed_amount: '300.00' },
    session: { cpt_code: '90837', session_date: '2026-06-01', diagnosis_codes: many },
    sessions: [line({ id: 's1', line_charge: '150.00' }),
      line({ id: 's2', line_charge: '150.00', session_date: '2026-06-08' })],
  });
  body.claimInformation.serviceLines.forEach((l) => {
    const pointers = l.professionalService.compositeDiagnosisCodePointers.diagnosisCodePointers;
    assert.ok(pointers.length <= 4, 'at most four pointers per line, got ' + pointers.length);
  });
});

// --- runner -------------------------------------------------------------------

let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log('  ok  ' + t.name);
  } catch (err) {
    failed++;
    console.error('FAIL  ' + t.name + '\n      ' + (err && err.message));
  }
}
console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
