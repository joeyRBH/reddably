'use strict';

// Unit test — backend/lib/claim_grouping.js, the rules deciding which draft
// claims may be folded into ONE 837P carrying several service lines.
//
// MONEY-PATH. Getting these wrong does not produce a validation error, it
// produces a wrongly-FILED claim: sessions billed under the wrong rendering
// provider, against the wrong policy, or under a diagnosis that does not belong
// to them — discovered days later by a payer, against a real filing, on a real
// patient's coverage.
//
// The must-match rules all have the same root cause, which is worth stating
// once: the 837P carries exactly ONE client, rendering provider, policy, place
// of service and diagnosis set at the CLAIM level, not per service line. Two
// different values do not split the claim — the builder emits one of them and
// both services are filed under it, silently.
//
//   node backend/tests/claim_grouping.test.js

const assert = require('node:assert');
const G = require('../lib/claim_grouping');

// Two groupable draft claims for one client. Every case below starts here and
// changes exactly one thing, so a failure names its own cause.
function claim(over) {
  return Object.assign({
    id: 'claim-1',
    session_id: 'session-1',
    client_id: 'client-1',
    clinician_id: 'user-1',
    insurance_record_id: 'ins-1',
    status: 'draft',
    billed_amount: 175,
    session_date: '2026-08-03',
    cpt_code: '90837',
    place_of_service: '10',
    diagnosis_codes: ['F411'],
    control_number: null,
    submitted_at: null,
    corrects_claim_id: null,
    submission_frequency_code: null,
  }, over || {});
}

function pair(overA, overB) {
  return [
    claim(overA),
    claim(Object.assign({ id: 'claim-2', session_id: 'session-2', session_date: '2026-08-10' }, overB || {})),
  ];
}

function codes(result) {
  return result.conflicts.map((c) => c.code).sort();
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- the happy path -----------------------------------------------------------

test('two matching drafts group, and the total is their sum', () => {
  const r = G.evaluateGroup(pair());
  assert.strictEqual(r.ok, true, JSON.stringify(r.conflicts));
  assert.strictEqual(r.total, 350);
  assert.strictEqual(r.lines, 2);
});

test('the total is exact to the cent', () => {
  // 3 x 116.66 through naive float addition is 349.98000000000005, and the claim
  // charge must equal the sum of the line charges EXACTLY or the payer rejects.
  const three = pair();
  three.push(claim({ id: 'claim-3', session_id: 'session-3', session_date: '2026-08-17' }));
  three.forEach((c) => { c.billed_amount = 116.66; });
  const r = G.evaluateGroup(three);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.total, 349.98, 'no floating-point residue reaches the filing');
});

test('diagnoses match as a SET, not by order', () => {
  const r = G.evaluateGroup(pair(
    { diagnosis_codes: ['F411', 'F321'] },
    { diagnosis_codes: ['f321', ' F411 '] }   // reordered, recased, padded
  ));
  assert.strictEqual(r.ok, true, 'the same diagnoses in any order are the same claim');
});

test('lines are ordered by date of service, earliest first', () => {
  const [a, b] = pair();
  const ordered = G.orderForFiling([b, a]);
  assert.strictEqual(ordered[0].session_date, '2026-08-03');
  assert.strictEqual(ordered[1].session_date, '2026-08-10');
});

test('an undated claim sorts last rather than being dropped', () => {
  const [a, b] = pair({}, { session_date: null });
  const ordered = G.orderForFiling([b, a]);
  assert.strictEqual(ordered.length, 2, 'nothing is silently discarded');
  assert.strictEqual(ordered[0].session_date, '2026-08-03');
});

// --- claim-level fields that must match ---------------------------------------

test('a different client cannot be grouped', () => {
  const r = G.evaluateGroup(pair({}, { client_id: 'client-2' }));
  assert.strictEqual(r.ok, false);
  assert.ok(codes(r).indexOf('mixed_client_id') !== -1);
});

test('a different rendering clinician cannot be grouped', () => {
  // The 837P names ONE rendering provider. Grouping across clinicians would file
  // one clinician's session under the other's NPI.
  const r = G.evaluateGroup(pair({}, { clinician_id: 'user-2' }));
  assert.ok(codes(r).indexOf('mixed_clinician_id') !== -1);
});

test('a different insurance policy cannot be grouped', () => {
  const r = G.evaluateGroup(pair({}, { insurance_record_id: 'ins-2' }));
  assert.ok(codes(r).indexOf('mixed_insurance_record_id') !== -1);
});

test('a different place of service cannot be grouped', () => {
  const r = G.evaluateGroup(pair({}, { place_of_service: '11' }));
  assert.ok(codes(r).indexOf('mixed_place_of_service') !== -1);
});

test('different diagnoses cannot be grouped, and the reason says why', () => {
  const r = G.evaluateGroup(pair({}, { diagnosis_codes: ['F321'] }));
  assert.ok(codes(r).indexOf('mixed_diagnoses') !== -1);
  const msg = r.conflicts.find((c) => c.code === 'mixed_diagnoses').message;
  assert.ok(/sit on the claim, not the service line/i.test(msg),
    'the message explains the mechanism, not just the refusal');
});

// --- per-claim eligibility ----------------------------------------------------

test('a submitted claim cannot be grouped', () => {
  const r = G.evaluateGroup(pair({}, { status: 'submitted' }));
  assert.ok(codes(r).indexOf('not_draft') !== -1);
});

test('a draft that was already transmitted cannot be grouped', () => {
  // A draft carrying a control number was handed to the clearinghouse at some
  // point. Folding it into a NEW original filing would be a duplicate.
  const r = G.evaluateGroup(pair({}, { control_number: 'CN123' }));
  assert.ok(codes(r).indexOf('previously_transmitted') !== -1);

  const r2 = G.evaluateGroup(pair({}, { submitted_at: '2026-08-11T00:00:00Z' }));
  assert.ok(codes(r2).indexOf('previously_transmitted') !== -1);
});

test('a replacement claim cannot be grouped', () => {
  const byRef = G.evaluateGroup(pair({}, { corrects_claim_id: 'claim-0' }));
  assert.ok(codes(byRef).indexOf('replacement') !== -1);

  const byFreq = G.evaluateGroup(pair({}, { submission_frequency_code: '7' }));
  assert.ok(codes(byFreq).indexOf('replacement') !== -1, 'either signal is enough');
});

test('a claim with no billed amount cannot be grouped', () => {
  // Every service line needs its own charge, because the payer requires the
  // lines to add up to the claim total.
  [null, 0, undefined].forEach((amount) => {
    const r = G.evaluateGroup(pair({}, { billed_amount: amount }));
    assert.ok(codes(r).indexOf('missing_amount') !== -1, 'amount ' + String(amount));
  });
});

test('the same session twice is refused', () => {
  const r = G.evaluateGroup(pair({}, { session_id: 'session-1' }));
  assert.ok(codes(r).indexOf('duplicate_session') !== -1,
    'grouping a session with itself would bill the payer for it twice');
});

// --- shape / bounds -----------------------------------------------------------

test('fewer than two claims is not a group', () => {
  assert.strictEqual(G.evaluateGroup([claim()]).ok, false);
  assert.strictEqual(G.evaluateGroup([]).ok, false);
  assert.strictEqual(G.evaluateGroup(null).ok, false);
});

test('more lines than a claim form holds is refused', () => {
  const many = [];
  for (let i = 0; i < G.MAX_GROUPED_LINES + 1; i += 1) {
    many.push(claim({ id: 'c' + i, session_id: 's' + i, session_date: '2026-08-0' + (i % 9) }));
  }
  const r = G.evaluateGroup(many);
  assert.strictEqual(r.ok, false);
  assert.ok(codes(r).indexOf('too_many') !== -1);
});

test('EVERY conflict is reported, not just the first', () => {
  // A user who ticked six rows should learn everything wrong in one pass rather
  // than discovering it one refusal at a time.
  const r = G.evaluateGroup(pair({}, {
    client_id: 'client-2',
    place_of_service: '11',
    status: 'submitted',
  }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.conflicts.length >= 3, 'got ' + r.conflicts.length + ' conflicts');
  ['mixed_client_id', 'mixed_place_of_service', 'not_draft'].forEach((code) => {
    assert.ok(codes(r).indexOf(code) !== -1, 'reports ' + code);
  });
});

test('conflict messages name dates of service, never patient identifiers', () => {
  const r = G.evaluateGroup(pair({}, { status: 'submitted' }));
  const text = r.conflicts.map((c) => c.message).join(' ');
  assert.ok(/2026-08-10/.test(text), 'the offending service date is named');
  assert.ok(!/client-1|client-2|ins-1|user-1|F411/.test(text),
    'no client id, policy id, user id or diagnosis code leaks into a message');
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
