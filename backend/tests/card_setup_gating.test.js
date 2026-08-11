'use strict';

// Unit tests — patient intake gating + auto client status
// (backend/handlers/card_setup.js).
//
// Covers:
//   * save-insurance REJECTS a payer-less save (no payer_id, no escape flag) — the
//     UI gate is not the gate; this route is reachable with just the link token;
//   * the "can't find my insurer" escape hatch saves with payer_id NULL and leaves
//     the client on 'awaiting_info' (i.e. on the practice's follow-up list);
//   * a complete intake promotes 'awaiting_info' → 'active', from either the
//     insurance step or the details step (whichever completes the picture);
//   * the transition is guarded to FROM 'awaiting_info' — a client the practice set
//     to 'inactive' is never flipped back by a re-opened link;
//   * a card on file is NOT required to become 'active';
//   * save-details validates the patient's biological sex against the
//     female|male|unknown vocabulary and never nulls an existing value with a blank;
//   * the status-change audit row carries field names only — no PHI.
//
// No network, no real DB: the db / payment_token modules are stubbed. Tests run
// sequentially (they share the in-memory state).
//
//   node backend/tests/card_setup_gating.test.js

const assert = require('node:assert');
const path = require('node:path');

const CLIENT_ID = '23b84bce-0000-4000-8000-000000000001';
const PRACTICE_ID = '92b4b624-0000-4000-8000-000000000002';
const TOKEN = 'signed-payment-token';

// The signed payment token is the only credential this flow has; stub it to a
// fixed client so the tests exercise the handler, not JWT.
const tokenLib = require(path.join(__dirname, '..', 'lib', 'payment_token.js'));
tokenLib.verify = (t) => {
  if (t !== TOKEN) throw new Error('bad token');
  return { client_id: CLIENT_ID };
};

const dbLib = require(path.join(__dirname, '..', 'lib', 'db.js'));
const handler = require(path.join(__dirname, '..', 'handlers', 'card_setup.js')).handler;

// --- in-memory clients + insurance_records ----------------------------------

const state = { client: null, insurance: null, audits: [] };

// A client mid-intake: demographics already saved, no insurance yet, no card.
// (No card on purpose — a client must be able to reach 'active' without one.)
function freshClient(overrides) {
  return Object.assign(
    {
      id: CLIENT_ID,
      practice_id: PRACTICE_ID,
      status: 'awaiting_info',
      is_hidden: false,
      date_of_birth: '1990-01-01',
      gender: 'female',
      address_line1: '1 Main St',
      city: 'Denver',
      state: 'CO',
      postal_code: '80202',
      payment_method_id: null,
    },
    overrides || {}
  );
}

function reset(clientOverrides, insurance) {
  state.client = freshClient(clientOverrides);
  state.insurance = insurance || null;
  state.audits = [];
}

function notBlank(v) {
  return v != null && String(v).trim() !== '';
}

dbLib.query = async (text, params) => {
  const t = String(text);
  const c = state.client;

  // loadClient
  if (/select \* from clients where id = \$1/.test(t)) {
    return c ? { rows: [c], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  // resolveNotificationEmail — no recipient configured, so no intake email is sent.
  if (/from practices/.test(t)) return { rows: [{ recipient: null }], rowCount: 1 };

  // save-details
  // Param layout: $1 dob, $2 gender, $3 address1, $4 address2, $5 city, $6 state,
  // $7 postal_code, $8 phone, $9 client id. Every column uses
  // coalesce(nullif($n, ''), col) — a blank incoming value keeps what is on file.
  if (/update clients set\s*\n?\s*date_of_birth/.test(t) || /date_of_birth = coalesce/.test(t)) {
    if (!c) return { rows: [], rowCount: 0 };
    const [dob, gender, a1, , city, st, zip] = params;
    if (notBlank(dob)) c.date_of_birth = dob;
    if (notBlank(gender)) c.gender = gender;
    if (notBlank(a1)) c.address_line1 = a1;
    if (notBlank(city)) c.city = city;
    if (notBlank(st)) c.state = st;
    if (notBlank(zip)) c.postal_code = zip;
    return { rows: [{ practice_id: c.practice_id }], rowCount: 1 };
  }

  // existing primary insurance record lookup
  if (/select id from insurance_records/.test(t)) {
    return state.insurance
      ? { rows: [{ id: state.insurance.id }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  if (/update insurance_records set/.test(t)) {
    // Param layout (save-insurance UPDATE): $1 carrier, $2 member, $3 group,
    // $4 relationship, $5 subscriberIsSelf, $6 name, $7 dob, $8 gender,
    // $9-13 address lines, $14 payer_id, $15 id. (Policyholder demographics were
    // added; payer_id shifted from $7 to $14.)
    const [carrier, member, , relationship, isSelf, name, dob, gender, a1, a2, city, st, zip, payerId] = params;
    const r = state.insurance;
    if (notBlank(carrier)) r.carrier_name = carrier;
    if (notBlank(member)) r.member_id = member;
    if (notBlank(relationship)) r.subscriber_relationship = relationship;
    // Mirror the SQL `case when $5 then null else coalesce(nullif($n,''), col)`:
    // a self-flip ($5 true) clears every policyholder column; a dependent update
    // coalesces (a blank incoming value keeps the existing one).
    const setOrClear = (cur, incoming) => (isSelf ? null : (notBlank(incoming) ? incoming : cur));
    r.subscriber_name = setOrClear(r.subscriber_name, name);
    r.subscriber_dob = setOrClear(r.subscriber_dob, dob);
    r.subscriber_gender = setOrClear(r.subscriber_gender, gender);
    r.subscriber_address_line1 = setOrClear(r.subscriber_address_line1, a1);
    r.subscriber_address_line2 = setOrClear(r.subscriber_address_line2, a2);
    r.subscriber_city = setOrClear(r.subscriber_city, city);
    r.subscriber_state = setOrClear(r.subscriber_state, st);
    r.subscriber_postal_code = setOrClear(r.subscriber_postal_code, zip);
    r.payer_id = payerId; // authoritative: the picked id, or null via the escape hatch
    return { rows: [], rowCount: 1 };
  }

  if (/insert into insurance_records/.test(t)) {
    // Param layout (save-insurance INSERT): $1 practice_id, $2 client_id,
    // $3 carrier, $4 member, $5 group, $6 relationship, $7 name, $8 dob,
    // $9 gender, $10-14 address lines, $15 payer_id. (payer_id shifted from $9.)
    state.insurance = {
      id: 'ins_1',
      client_id: params[1],
      carrier_name: params[2],
      member_id: params[3],
      payer_id: params[14],
      is_primary: true,
      is_hidden: false,
    };
    return { rows: [], rowCount: 1 };
  }

  // intakeCompleteness
  if (/demographics_ok/.test(t)) {
    if (!c) return { rows: [], rowCount: 0 };
    const i = state.insurance;
    return {
      rows: [
        {
          demographics_ok:
            notBlank(c.date_of_birth) &&
            notBlank(c.address_line1) &&
            notBlank(c.city) &&
            notBlank(c.state) &&
            notBlank(c.postal_code),
          insurance_ok:
            !!i && notBlank(i.carrier_name) && notBlank(i.member_id) && notBlank(i.payer_id),
        },
      ],
      rowCount: 1,
    };
  }

  // the guarded promotion: only ever awaiting_info -> active
  if (/update clients set status = 'active'/.test(t)) {
    if (!c || c.is_hidden || c.status !== 'awaiting_info') return { rows: [], rowCount: 0 };
    c.status = 'active';
    return { rows: [], rowCount: 1 };
  }

  if (/insert into audit_log/.test(t)) {
    state.audits.push({
      practice_id: params[0],
      actor_type: params[2],
      action: params[3],
      metadata: params[9] ? JSON.parse(params[9]) : null,
    });
    return { rows: [], rowCount: 1 };
  }

  return { rows: [], rowCount: 0 };
};

// --- helpers ----------------------------------------------------------------

function call(subPath, body) {
  return handler({
    httpMethod: 'POST',
    rawPath: '/card-setup/' + subPath,
    requestContext: { http: { method: 'POST', path: '/card-setup/' + subPath } },
    headers: {},
    body: JSON.stringify(Object.assign({ token: TOKEN }, body)),
  });
}

const INSURANCE = {
  carrier_name: 'Aetna',
  member_id: 'W123456789',
  subscriber_relationship: 'self',
};

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// --- 1. the server is the gate ----------------------------------------------

test('save-insurance rejects a free-typed carrier with no payer pick (UI bypassed)', async () => {
  reset();
  const res = await call('save-insurance', INSURANCE); // no payer_id, no escape flag
  assert.strictEqual(res.statusCode, 400, 'expected a 400, got ' + res.statusCode);
  assert.match(JSON.parse(res.body).error, /choose the insurance company/i);
  assert.strictEqual(state.insurance, null, 'nothing should have been written');
  assert.strictEqual(state.client.status, 'awaiting_info');
});

test('save-insurance still rejects when payer_not_listed is falsy, not just absent', async () => {
  reset();
  const res = await call('save-insurance', Object.assign({ payer_not_listed: false }, INSURANCE));
  assert.strictEqual(res.statusCode, 400);
  // Only a literal `true` opens the escape hatch — no truthy-string smuggling.
  const res2 = await call(
    'save-insurance',
    Object.assign({ payer_not_listed: 'yes' }, INSURANCE)
  );
  assert.strictEqual(res2.statusCode, 400);
  assert.strictEqual(state.insurance, null);
});

// --- 2. the escape hatch ----------------------------------------------------

test('escape hatch saves with payer_id null and leaves the client awaiting follow-up', async () => {
  reset();
  const res = await call(
    'save-insurance',
    Object.assign({ payer_not_listed: true }, INSURANCE)
  );
  assert.strictEqual(res.statusCode, 200);
  assert.ok(state.insurance, 'insurance should have been saved');
  assert.strictEqual(state.insurance.carrier_name, 'Aetna');
  assert.strictEqual(state.insurance.member_id, 'W123456789');
  assert.strictEqual(state.insurance.payer_id, null, 'payer_id must be null');
  assert.strictEqual(
    state.client.status,
    'awaiting_info',
    'an escape-hatch client is NOT claim-ready'
  );
});

test('escape hatch clears a stale payer_id from an earlier pick', async () => {
  // Re-opened link: a previous pick left a payer id that no longer matches the
  // carrier name being saved now. A stale id routes the claim to the wrong payer.
  reset({}, { id: 'ins_1', carrier_name: 'Aetna', member_id: 'W1', payer_id: '60054' });
  const res = await call(
    'save-insurance',
    Object.assign({ payer_not_listed: true }, INSURANCE, { carrier_name: 'Tiny Regional Plan' })
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(state.insurance.payer_id, null);
  assert.strictEqual(state.client.status, 'awaiting_info');
});

// --- 3. auto-activation on a complete intake --------------------------------

test('a complete intake promotes awaiting_info -> active (with no card on file)', async () => {
  reset();
  assert.strictEqual(state.client.payment_method_id, null, 'precondition: no card');
  const res = await call('save-insurance', Object.assign({ payer_id: '60054' }, INSURANCE));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(state.insurance.payer_id, '60054');
  assert.strictEqual(state.client.status, 'active');

  const statusAudit = state.audits.find((a) => a.action === 'client.status_change');
  assert.ok(statusAudit, 'the status change must be audited');
  assert.strictEqual(statusAudit.actor_type, 'patient_link');
  assert.deepStrictEqual(statusAudit.metadata, {
    fields_changed: ['status'],
    status_from: 'awaiting_info',
    status_to: 'active',
  });
  // No PHI in the audit metadata — no name, DOB, member id, carrier.
  const blob = JSON.stringify(statusAudit.metadata);
  ['W123456789', 'Aetna', '1990-01-01', '1 Main St'].forEach((phi) => {
    assert.ok(!blob.includes(phi), 'audit metadata leaked PHI: ' + phi);
  });
});

test('incomplete demographics keep the client awaiting_info even with a payer pick', async () => {
  reset({ date_of_birth: null, address_line1: null, city: null, state: null, postal_code: null });
  const res = await call('save-insurance', Object.assign({ payer_id: '60054' }, INSURANCE));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(state.client.status, 'awaiting_info');
});

test('the details step completes the picture and promotes the client', async () => {
  // Insurance already on file (complete); demographics are the missing half.
  reset(
    { date_of_birth: null, address_line1: null, city: null, state: null, postal_code: null },
    { id: 'ins_1', carrier_name: 'Aetna', member_id: 'W1', payer_id: '60054' }
  );
  const res = await call('save-details', {
    date_of_birth: '1990-01-01',
    address_line1: '1 Main St',
    city: 'Denver',
    state: 'CO',
    postal_code: '80202',
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(state.client.status, 'active');
});

// --- 3b. biological sex captured at intake ----------------------------------
// The 837P needs the patient's gender demographic whenever the patient IS the
// subscriber. Intake now asks for it, so staff no longer key it in by hand.

test('save-details persists a valid biological sex', async () => {
  reset({ gender: null });
  const res = await call('save-details', {
    date_of_birth: '1990-01-01',
    gender: 'male',
    address_line1: '1 Main St',
    city: 'Denver',
    state: 'CO',
    postal_code: '80202',
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(state.client.gender, 'male');
});

test('save-details accepts every value in the female|male|unknown vocabulary', async () => {
  for (const value of ['female', 'male', 'unknown']) {
    reset({ gender: null });
    const res = await call('save-details', { gender: value });
    assert.strictEqual(res.statusCode, 200, value + ' should be accepted');
    assert.strictEqual(state.client.gender, value);
  }
});

test('save-details lower-cases the submitted value before storing it', async () => {
  // The DB CHECK only admits lowercase; a capitalized value must not 400 OR be
  // stored verbatim.
  reset({ gender: null });
  const res = await call('save-details', { gender: 'Female' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(state.client.gender, 'female');
});

test('save-details rejects a biological sex outside the vocabulary', async () => {
  reset({ gender: null });
  const res = await call('save-details', {
    date_of_birth: '1990-01-01',
    gender: 'other',
    address_line1: '1 Main St',
    city: 'Denver',
    state: 'CO',
    postal_code: '80202',
  });
  assert.strictEqual(res.statusCode, 400, 'expected a 400, got ' + res.statusCode);
  assert.match(JSON.parse(res.body).error, /invalid biological sex/i);
  assert.strictEqual(state.client.gender, null, 'nothing should have been written');
});

test('a blank biological sex does not null out the value already on file', async () => {
  // A patient who re-opens the link and re-submits the step without touching the
  // select must not wipe what staff (or an earlier submission) already recorded.
  reset({ gender: 'unknown' });
  const res = await call('save-details', {
    date_of_birth: '1990-01-01',
    gender: '',
    address_line1: '1 Main St',
    city: 'Denver',
    state: 'CO',
    postal_code: '80202',
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(state.client.gender, 'unknown');
});

// --- 4. the guard: never resurrect a client the practice retired -------------

test('an inactive client is NOT flipped to active by re-opening the link', async () => {
  reset({ status: 'inactive' });
  const res = await call('save-insurance', Object.assign({ payer_id: '60054' }, INSURANCE));
  assert.strictEqual(res.statusCode, 200, 'the save itself still succeeds');
  assert.strictEqual(state.insurance.payer_id, '60054', 'the insurance is still saved');
  assert.strictEqual(state.client.status, 'inactive', 'status must be left alone');
  assert.ok(
    !state.audits.some((a) => a.action === 'client.status_change'),
    'no status change, so no status-change audit'
  );
});

test('an already-active client stays active and logs no spurious status change', async () => {
  reset({ status: 'active' });
  const res = await call('save-insurance', Object.assign({ payer_id: '60054' }, INSURANCE));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(state.client.status, 'active');
  assert.ok(!state.audits.some((a) => a.action === 'client.status_change'));
});

// --- 4. self-reset: flipping the relationship to self clears policyholder PHI --

test('correcting the relationship to self wipes stale policyholder demographics', async () => {
  // Start from a record that names a dependent policyholder with full demographics.
  reset({ status: 'active' }, {
    id: 'ins_1',
    carrier_name: 'Surest',
    member_id: 'W123456789',
    payer_id: '60054',
    subscriber_relationship: 'child',
    subscriber_name: 'Pat Rivera',
    subscriber_dob: '1965-02-10',
    subscriber_gender: 'male',
    subscriber_address_line1: '99 Holder Ave',
    subscriber_address_line2: 'Unit 4',
    subscriber_city: 'Boulder',
    subscriber_state: 'CO',
    subscriber_postal_code: '80301',
  });

  // The patient corrects themselves to "I am the policyholder" (self). The page
  // then submits only the base insurance fields (relationship 'self').
  const res = await call('save-insurance', Object.assign({ payer_id: '60054' }, INSURANCE));
  assert.strictEqual(res.statusCode, 200);

  const i = state.insurance;
  assert.strictEqual(i.subscriber_relationship, 'self', 'relationship recorded as self');
  for (const col of [
    'subscriber_name', 'subscriber_dob', 'subscriber_gender',
    'subscriber_address_line1', 'subscriber_address_line2',
    'subscriber_city', 'subscriber_state', 'subscriber_postal_code',
  ]) {
    assert.strictEqual(i[col], null, col + ' must be cleared when relationship flips to self');
  }
  // The policy's own (non-policyholder) fields carry the submitted values and are
  // unaffected by the self-reset.
  assert.strictEqual(i.carrier_name, 'Aetna', 'carrier updated from the submitted body');
  assert.strictEqual(i.member_id, 'W123456789', 'member id present');
  assert.strictEqual(i.payer_id, '60054', 'payer id present');
});

// --- runner -----------------------------------------------------------------

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
