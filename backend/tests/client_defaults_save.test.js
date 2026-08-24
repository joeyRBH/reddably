'use strict';

// Unit test — the "☐ Also save these as <Client>'s defaults" control
// (public/app/client-defaults.js).
//
// Two guarantees, both of which are about NOT writing things:
//
// 1. FIELD-LIMITED. The defaults payload is built exclusively from the object
//    that was just successfully written, intersected with the defaultable fields
//    and the fields that form actually exposes. It is never reconstructed from a
//    client or session row in scope. Edit claim exposes dx / CPT / fee, so
//    ticking the box there writes exactly those three client defaults and leaves
//    place-of-service and modifiers UNTOUCHED — absent from the request, not
//    sent as null.
//
// 2. AN EMPTY VALUE NEVER CLEARS A DEFAULT. The two forms disagree about clears
//    (the session form strips empties via compact(); Edit claim sends explicit
//    ones), so mirroring the payload verbatim would make one checkbox mean
//    "clear my default" on one screen and "leave it alone" on the other.
//
// Plus the partial-success contract: the session/claim write is authoritative
// and happens first; if it succeeds and the defaults PATCH fails, nothing is
// rolled back, the user is told specifically what did and did not happen, and no
// generic success is shown implying both landed.
//
// client-defaults.js is a browser IIFE with no DOM dependency at all — it is
// evaluated against a fake window.Reddably whose api and toast are recording
// stubs. Fixtures are synthetic — no PHI.
//
//   node backend/tests/client_defaults_save.test.js

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// --- load the module against a recording kit ---------------------------------

const toasts = [];
const calls = [];
let updateBehaviour = () => Promise.resolve({ client: {} });

const Reddably = {
  api: {
    clients: {
      update(id, payload) {
        calls.push({ name: 'clients.update', id, payload });
        return updateBehaviour();
      },
    },
  },
  toast(message, tone, dwell) { toasts.push({ message, tone, dwell }); },
};

const SOURCE = path.join(__dirname, '..', '..', 'public', 'app', 'client-defaults.js');
const SRC = fs.readFileSync(SOURCE, 'utf8');
vm.runInNewContext(SRC, { window: { Reddably }, console, Promise });

const CD = Reddably.clientDefaults;
assert.ok(CD, 'client-defaults.js attaches to the Reddably namespace');

// The module is evaluated in its own realm, so the objects it builds carry that
// realm's Object.prototype and deepStrictEqual rejects them as not
// reference-equal. Normalize before structural comparison — same helper the
// other view tests here use.
function plain(v) {
  return JSON.parse(JSON.stringify(v === undefined ? null : v));
}

function reset() {
  toasts.length = 0;
  calls.length = 0;
  updateBehaviour = () => Promise.resolve({ client: {} });
}

// The field names each real form exposes, kept in step with the views.
const EDIT_CLAIM_FIELDS = ['session_date', 'cpt_code', 'diagnosis_codes', 'fee',
  'save_as_client_defaults'];
const SESSION_FIELDS = ['session_date', 'clinician_id', 'cpt_code', 'diagnosis_codes',
  'place_of_service', 'procedure_modifiers', 'fee', 'notes', 'save_as_client_defaults'];

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- 1. field-limited ---------------------------------------------------------

test('Edit claim writes exactly its own three defaults, and nothing else', () => {
  // Exactly what views/claims.js sends to sessions.update.
  const submitted = {
    session_date: '2026-08-01',
    cpt_code: '90837',
    fee: 200,
    diagnosis_codes: ['F411'],
  };
  const payload = CD.buildPayload(submitted, EDIT_CLAIM_FIELDS);

  assert.deepStrictEqual(Object.keys(payload).sort(),
    ['default_cpt_code', 'default_session_fee', 'diagnosis_codes'],
    'exactly the three fields this form exposes');

  // The point of the whole design: not present, as opposed to present-and-null.
  assert.ok(!('default_place_of_service' in payload),
    'place of service is ABSENT, not sent as null');
  assert.ok(!('default_procedure_modifiers' in payload),
    'modifiers are ABSENT, not sent as null');
});

test('a field on the form but NOT in the write is not defaulted', () => {
  // The user edited only the date; cpt_code never entered the payload.
  const payload = CD.buildPayload({ session_date: '2026-08-01' }, EDIT_CLAIM_FIELDS);
  assert.deepStrictEqual(plain(payload), {}, 'nothing to save');
});

test('a field in the write but NOT on the form is not defaulted', () => {
  // Guards against sourcing from anything other than (form ∩ write): a stray key
  // on the payload must not become a default just because it is defaultable.
  const payload = CD.buildPayload(
    { cpt_code: '90837', place_of_service: '10' },
    EDIT_CLAIM_FIELDS
  );
  assert.deepStrictEqual(plain(payload), { default_cpt_code: '90837' },
    'place_of_service is not on the Edit claim form, so it is not written');
});

test('the session form, which exposes all five, writes all five', () => {
  const payload = CD.buildPayload({
    cpt_code: '90834',
    place_of_service: '10',
    procedure_modifiers: ['95'],
    fee: 150,
    diagnosis_codes: ['F411'],
  }, SESSION_FIELDS);

  assert.deepStrictEqual(plain(payload), {
    default_cpt_code: '90834',
    default_place_of_service: '10',
    default_procedure_modifiers: ['95'],
    default_session_fee: 150,
    diagnosis_codes: ['F411'],
  });
});

// --- 2. empties never clear ---------------------------------------------------

test('empty values are skipped rather than clearing the default', () => {
  // Exactly what Edit claim sends when the user blanks the fields: explicit
  // clears, which the SESSION write honours and the DEFAULTS write must not.
  const payload = CD.buildPayload({
    cpt_code: null,
    fee: '',
    diagnosis_codes: [],
    session_date: '2026-08-01',
  }, EDIT_CLAIM_FIELDS);

  assert.deepStrictEqual(plain(payload), {},
    'blanking a session field must never destroy the client default');
});

test('a zero fee is a real value, not an empty one', () => {
  const payload = CD.buildPayload({ fee: 0 }, SESSION_FIELDS);
  assert.deepStrictEqual(plain(payload), { default_session_fee: 0 },
    'a genuinely free session is a default worth keeping');
});

// --- 3. the partial-success contract -----------------------------------------

test('unticked: the primary write runs and the defaults PATCH never fires', async () => {
  reset();
  await CD.submitWithDefaults({
    write: () => Promise.resolve({ ok: true }),
    saveDefaults: false,
    clientId: 'c-1',
    payload: { cpt_code: '90837' },
    fieldNames: EDIT_CLAIM_FIELDS,
    successMessage: 'Claim updated from session',
    partialMessage: 'Claim updated, but client defaults could not be saved.',
  });

  assert.strictEqual(calls.length, 0, 'no defaults request');
  assert.deepStrictEqual(toasts.map((t) => t.tone), ['success']);
  assert.strictEqual(toasts[0].message, 'Claim updated from session');
});

test('ticked and both succeed: one success naming the defaults', async () => {
  reset();
  let settled = 0;
  await CD.submitWithDefaults({
    write: () => Promise.resolve({ ok: true }),
    saveDefaults: true,
    clientId: 'c-1',
    payload: { cpt_code: '90837', fee: 200 },
    fieldNames: EDIT_CLAIM_FIELDS,
    successMessage: 'Claim updated from session',
    partialMessage: 'Claim updated, but client defaults could not be saved.',
    onSettled: () => { settled += 1; },
  });

  assert.strictEqual(calls.length, 1, 'exactly one defaults request');
  assert.strictEqual(calls[0].id, 'c-1');
  assert.deepStrictEqual(plain(calls[0].payload),
    { default_cpt_code: '90837', default_session_fee: 200 });
  assert.strictEqual(toasts.length, 1);
  assert.strictEqual(toasts[0].tone, 'success');
  assert.ok(/defaults saved/.test(toasts[0].message),
    'the success copy NAMES the defaults, so it cannot be reused for the partial case');
  assert.strictEqual(settled, 1, 'the view reloads');
});

test('PRIMARY write fails: it rejects, and the defaults PATCH never fires', async () => {
  reset();
  let settled = 0;
  await assert.rejects(
    () => CD.submitWithDefaults({
      write: () => Promise.reject(new Error('Session is no longer editable.')),
      saveDefaults: true,
      clientId: 'c-1',
      payload: { cpt_code: '90837' },
      fieldNames: EDIT_CLAIM_FIELDS,
      successMessage: 'Claim updated from session',
      partialMessage: 'Claim updated, but client defaults could not be saved.',
      onSettled: () => { settled += 1; },
    }),
    /no longer editable/
  );

  assert.strictEqual(calls.length, 0,
    'the defaults write never runs when the authoritative write failed');
  assert.strictEqual(toasts.length, 0, 'the caller owns the error message');
  assert.strictEqual(settled, 0);
});

test('DEFAULTS write fails: specific warning, no false success, no rollback', async () => {
  reset();
  updateBehaviour = () => Promise.reject(new Error('network'));
  let settled = 0;
  const result = await CD.submitWithDefaults({
    write: () => Promise.resolve({ ok: true }),
    saveDefaults: true,
    clientId: 'c-1',
    payload: { cpt_code: '90837' },
    fieldNames: EDIT_CLAIM_FIELDS,
    successMessage: 'Claim updated from session',
    partialMessage: 'Claim updated, but client defaults could not be saved.',
    onSettled: () => { settled += 1; },
  });

  // Does NOT reject: a defaults failure is not a failed claim edit, and must
  // never reach the caller's .catch to be reported as one.
  assert.deepStrictEqual(plain(result), { ok: true },
    'the primary write result is still returned — nothing is rolled back');

  assert.strictEqual(toasts.length, 1, 'exactly one message');
  assert.strictEqual(toasts[0].tone, 'warn', 'a warning, not an error and not a success');
  assert.strictEqual(toasts[0].message,
    'Claim updated, but client defaults could not be saved.');
  assert.ok(toasts[0].dwell >= 8000,
    'long dwell — a warning about work the user must redo cannot flash past');

  // The specific thing the contract forbids.
  assert.ok(!toasts.some((t) => t.tone === 'success'),
    'no success toast may imply both operations completed');

  assert.strictEqual(settled, 1,
    'the view still reloads, so the screen corroborates the message');
});

test('ticked but nothing defaultable was written: no request, plain success', async () => {
  reset();
  await CD.submitWithDefaults({
    write: () => Promise.resolve({ ok: true }),
    saveDefaults: true,
    clientId: 'c-1',
    payload: { session_date: '2026-08-01' },   // nothing defaultable
    fieldNames: EDIT_CLAIM_FIELDS,
    successMessage: 'Claim updated from session',
    partialMessage: 'Claim updated, but client defaults could not be saved.',
  });

  assert.strictEqual(calls.length, 0, 'an empty defaults payload is not sent');
  assert.strictEqual(toasts[0].tone, 'success');
  assert.strictEqual(toasts[0].message, 'Claim updated from session',
    'and the message does not claim defaults were saved');
});

test('retrying is idempotent: same input, same single field-set write', async () => {
  reset();
  const opts = () => ({
    write: () => Promise.resolve({ ok: true }),
    saveDefaults: true,
    clientId: 'c-1',
    payload: { cpt_code: '90837' },
    fieldNames: EDIT_CLAIM_FIELDS,
    successMessage: 'Claim updated from session',
    partialMessage: 'Claim updated, but client defaults could not be saved.',
  });
  await CD.submitWithDefaults(opts());
  await CD.submitWithDefaults(opts());

  assert.strictEqual(calls.length, 2, 'two attempts');
  assert.deepStrictEqual(plain(calls[0].payload), plain(calls[1].payload),
    'identical field-set payloads — no counters, no appends, nothing accumulates');
});

// --- 4. the checkbox is never pre-ticked -------------------------------------

test('the checkbox is UI-only and carries no remembered state', () => {
  let seen = null;
  const field = CD.checkboxField('Test Client', (on) => { seen = on; });

  assert.strictEqual(field.type, 'checkbox');
  assert.strictEqual(field.uiOnly, true,
    'an instruction, not a field — it must never reach the submitted payload');
  assert.ok(!('value' in field) && !field.checked,
    'nothing pre-ticks it: saving a default must be a conscious choice each time');
  assert.ok(/Test Client/.test(field.label), 'the label names the client');

  field.onToggle(true);
  assert.strictEqual(seen, true, 'state is reported through onToggle');
  field.onToggle(false);
  assert.strictEqual(seen, false);
});

test('the field map mirrors the backend column map', () => {
  // A drift here silently writes defaults to the wrong column, or silently stops
  // writing one. backend/lib/billing_fields.js is the other half.
  const backend = require('../lib/billing_fields');
  assert.deepStrictEqual(plain(CD.DEFAULTABLE), plain(backend.CLIENT_DEFAULT_COLUMNS),
    'public/app/client-defaults.js DEFAULTABLE === backend CLIENT_DEFAULT_COLUMNS');
});

// --- runner -------------------------------------------------------------------

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log('  ok  ' + t.name);
    } catch (err) {
      failed++;
      console.error('FAIL  ' + t.name + '\n      ' + (err && err.message));
    }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
