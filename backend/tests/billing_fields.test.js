'use strict';

// Unit test — backend/lib/billing_fields.js.
//
// This module was extracted from backend/handlers/sessions.js because clients
// now hold per-client DEFAULTS for the same billable fields, so the same values
// are validated on two routes. A second copy of the rules would be a second,
// silently divergent definition of what a valid place of service or procedure
// modifier is — and one of those copies decides what rides the 837P.
//
// Covers the extracted parsers (their behaviour must be identical to what the
// sessions handler enforced before the move — place_of_service.test.js and
// session_procedure_modifiers.test.js guard the handler side) and the seeding
// rule that makes calendar promotion useful.
//
//   node backend/tests/billing_fields.test.js

const assert = require('node:assert');
const BF = require('../lib/billing_fields');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- the column map -----------------------------------------------------------

test('the column map covers exactly the five defaultable fields', () => {
  assert.deepStrictEqual(Object.keys(BF.CLIENT_DEFAULT_COLUMNS).sort(),
    ['cpt_code', 'diagnosis_codes', 'fee', 'place_of_service', 'procedure_modifiers']);
  // diagnosis_codes maps to itself: it predates the others (migration 008) and
  // kept its column name rather than being renamed for symmetry.
  assert.strictEqual(BF.CLIENT_DEFAULT_COLUMNS.diagnosis_codes, 'diagnosis_codes');
  assert.strictEqual(BF.CLIENT_DEFAULT_COLUMNS.fee, 'default_session_fee');
});

test('the map is frozen — it is a definition, not a scratchpad', () => {
  assert.throws(() => { 'use strict'; BF.CLIENT_DEFAULT_COLUMNS.cpt_code = 'nope'; });
});

// --- seeding ------------------------------------------------------------------

test('a blank field takes the client default', () => {
  const out = BF.applyClientDefaults(
    { cpt_code: null, place_of_service: null, fee: null },
    { default_cpt_code: '90837', default_place_of_service: '10', default_session_fee: 175 }
  );
  assert.strictEqual(out.cpt_code, '90837');
  assert.strictEqual(out.place_of_service, '10');
  assert.strictEqual(out.fee, 175);
});

test('a supplied value always wins over the default', () => {
  const out = BF.applyClientDefaults(
    { cpt_code: '90834', fee: 90 },
    { default_cpt_code: '90837', default_session_fee: 175 }
  );
  assert.strictEqual(out.cpt_code, '90834', 'the request wins');
  assert.strictEqual(out.fee, 90);
});

test('a zero fee is a supplied value, not a blank', () => {
  // The bug this guards: a truthiness test would treat a free session as unset
  // and silently bill the client's default rate for it.
  const out = BF.applyClientDefaults({ fee: 0 }, { default_session_fee: 175 });
  assert.strictEqual(out.fee, 0, 'a deliberate zero must survive');
});

test('a client with no defaults changes nothing', () => {
  const input = { cpt_code: null, fee: null };
  const out = BF.applyClientDefaults(input, { id: 'c-1' });
  assert.strictEqual(out.cpt_code, null);
  assert.strictEqual(out.fee, null);
});

test('a null client is tolerated and changes nothing', () => {
  const out = BF.applyClientDefaults({ cpt_code: null }, null);
  assert.strictEqual(out.cpt_code, null);
});

test('neither argument is mutated', () => {
  const input = { cpt_code: null };
  const client = { default_cpt_code: '90837' };
  const out = BF.applyClientDefaults(input, client);
  assert.strictEqual(input.cpt_code, null, 'input untouched');
  assert.strictEqual(client.default_cpt_code, '90837', 'client untouched');
  assert.strictEqual(out.cpt_code, '90837');
});

// --- the extracted parsers ----------------------------------------------------

test('parseMoney: blank is null, negatives and junk are rejected', () => {
  assert.deepStrictEqual(BF.parseMoney(null), { ok: true, value: null });
  assert.deepStrictEqual(BF.parseMoney(''), { ok: true, value: null });
  assert.deepStrictEqual(BF.parseMoney('175.50'), { ok: true, value: 175.5 });
  assert.deepStrictEqual(BF.parseMoney(0), { ok: true, value: 0 });
  assert.strictEqual(BF.parseMoney(-1).ok, false);
  assert.strictEqual(BF.parseMoney('abc').ok, false);
});

test('parsePlaceOfService: only real two-character CMS codes', () => {
  assert.deepStrictEqual(BF.parsePlaceOfService('11'), { ok: true, value: '11' });
  assert.deepStrictEqual(BF.parsePlaceOfService(''), { ok: true, value: null });
  // The literal value that got a live claim rejected by the payer.
  assert.strictEqual(BF.parsePlaceOfService('office').ok, false);
  assert.strictEqual(BF.parsePlaceOfService('99').ok, false);
});

test('parseProcedureModifiers: normalized, de-duplicated, capped', () => {
  assert.deepStrictEqual(BF.parseProcedureModifiers(['95']), { ok: true, value: ['95'] });
  assert.deepStrictEqual(BF.parseProcedureModifiers(['gt', 'GT']),
    { ok: true, value: ['GT'] }, 'uppercased and de-duplicated');
  assert.deepStrictEqual(BF.parseProcedureModifiers([]), { ok: true, value: null },
    'an empty list clears the column');
  assert.deepStrictEqual(BF.parseProcedureModifiers(['95', '']), { ok: true, value: ['95'] },
    'blanks are dropped');
  assert.strictEqual(BF.parseProcedureModifiers(['toolong']).ok, false,
    'a malformed code is a hard failure, never a silent drop');
  assert.strictEqual(
    BF.parseProcedureModifiers(['95', 'GT', 'HO', 'HN', 'AJ']).ok, false,
    'more than four DISTINCT modifiers is a failure, never a truncation'
  );
  assert.strictEqual(BF.parseProcedureModifiers('95').ok, false, 'must be an array');
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
