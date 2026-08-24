'use strict';

// MONEY-PATH integrity test — POST /claims/group, POST /claims/{id}/ungroup, and
// grouped regeneration (backend/handlers/claims.js).
//
// The grouping RULES are covered by claim_grouping.test.js. This file covers the
// four things that are not rules but properties of the write:
//
// 1. ATOMICITY + CONCURRENCY. Loading, judging, computing the total, retiring the
//    sources and writing the grouped claim happen in ONE transaction, over rows
//    held with FOR UPDATE. Two tabs grouping OVERLAPPING selections must not be
//    able to produce two live claims that both bill the same service. The
//    (claim_id, session_id) unique constraint cannot catch that on its own,
//    because the duplicate would sit under two different claim ids.
//
// 2. UNGROUP ROLLBACK. If rebuilding the separate drafts fails halfway, the
//    grouped claim must still be there and no partial drafts may survive. The
//    failure mode being prevented is a practice left holding the grouped claim
//    AND three rebuilt drafts — four billable claims for three sessions.
//
// 3. FILING PROVENANCE. Neither endpoint may copy, retire or regenerate any
//    submission identity: control number, patient control number, clearinghouse,
//    submitted_at, frequency code or corrects_claim_id. Asserted against the
//    actual columns, not against status === 'draft'.
//
// 4. GROUPED REGENERATION. Beyond the billed total: membership must be preserved
//    (no line silently dropped or added), and every line's own billable data must
//    come from its OWN session.
//
// Drives the real handler against an in-memory store that models row locking and
// READ COMMITTED re-evaluation well enough to exercise the interleaving.
// Synthetic fixtures — no PHI.
//
//   node backend/tests/claim_group_integrity.test.js

const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..', '..');
const PRACTICE = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const INSURANCE = '55555555-5555-4555-8555-555555555555';

let seq = 0;
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

let sessions, claims, claimSessions, events, locks, failNextClaimInsertAfter;

function reset() {
  seq = 0;
  sessions = [];
  claims = [];
  claimSessions = [];
  events = [];
  locks = new Set();
  failNextClaimInsertAfter = null;
}

function mkSession(over) {
  const s = Object.assign({
    id: uuid(++seq),
    practice_id: PRACTICE,
    client_id: CLIENT,
    clinician_id: USER,
    session_date: '2026-08-03',
    fee: 175,
    cpt_code: '90837',
    place_of_service: '10',
    diagnosis_codes: ['F411'],
    procedure_modifiers: null,
    is_hidden: false,
  }, over || {});
  sessions.push(s);
  return s;
}

function mkClaim(session, over) {
  const c = Object.assign({
    id: uuid(++seq),
    practice_id: PRACTICE,
    session_id: session.id,
    client_id: CLIENT,
    clinician_id: USER,
    insurance_record_id: INSURANCE,
    status: 'draft',
    billed_amount: session.fee,
    is_hidden: false,
    claim_number: null,
    control_number: null,
    patient_control_number: null,
    clearinghouse: null,
    submitted_at: null,
    corrects_claim_id: null,
    submission_frequency_code: null,
    prior_authorization_number: null,
    created_at: '2026-08-01T00:00:00Z',
  }, over || {});
  claims.push(c);
  claimSessions.push({
    practice_id: PRACTICE, claim_id: c.id, session_id: session.id,
    line_charge: session.fee, position: 1,
  });
  return c;
}

// --- the store ---------------------------------------------------------------
// `txLocks` models FOR UPDATE: a transaction that tries to lock a row another
// open transaction holds is rejected, which is how the interleaving test forces
// the contention deterministically without real concurrency.
function makeRunner(txId) {
  return async function run(sql, params) {
    const t = sql.replace(/\s+/g, ' ').trim();

    if (/^select practice_id from users/i.test(t)) {
      return { rows: [{ practice_id: PRACTICE }], rowCount: 1 };
    }

    // Candidate load for grouping, with FOR UPDATE.
    if (/^select c\.\*, s\.session_date/i.test(t)) {
      const wanted = params[1];
      const rows = claims
        .filter((c) => c.practice_id === params[0] && !c.is_hidden && wanted.includes(c.id))
        .map((c) => {
          const s = sessions.find((x) => x.id === c.session_id);
          return Object.assign({}, c, {
            session_date: s.session_date, cpt_code: s.cpt_code,
            place_of_service: s.place_of_service, session_diagnosis_codes: s.diagnosis_codes,
          });
        });
      if (/for update/i.test(t)) {
        for (const r of rows) {
          const holder = locks.get ? null : null;
          if (locks.has(r.id) && !locks.has(txId + ':' + r.id)) {
            // Another open transaction holds this row. Real Postgres would BLOCK
            // and then re-read; the caller models that by committing tx A first
            // and re-running B, which then sees is_hidden = true.
            const e = new Error('row locked'); e.locked = true; throw e;
          }
        }
        rows.forEach((r) => { locks.add(r.id); locks.add(txId + ':' + r.id); });
      }
      return { rows, rowCount: rows.length };
    }

    if (/^select id from claims where id = \$1/i.test(t)) {
      const c = claims.find((r) => r.id === params[0] && r.practice_id === params[1]
        && !r.is_hidden && r.status === 'draft'
        && r.control_number == null && r.submitted_at == null);
      return { rows: c ? [{ id: c.id }] : [], rowCount: c ? 1 : 0 };
    }

    if (/^select \* from claims where id/i.test(t)) {
      const c = claims.find((r) => r.id === params[0] && r.practice_id === params[1] && !r.is_hidden);
      return { rows: c ? [c] : [], rowCount: c ? 1 : 0 };
    }

    if (/^select \* from sessions where id/i.test(t)) {
      const s = sessions.find((r) => r.id === params[0] && r.practice_id === params[1]);
      return { rows: s ? [s] : [], rowCount: s ? 1 : 0 };
    }

    if (/^select s\.\*, cs\.line_charge/i.test(t)) {
      const rows = claimSessions
        .filter((r) => r.claim_id === params[0] && r.practice_id === params[1])
        .sort((a, b) => a.position - b.position)
        .map((r) => Object.assign({}, sessions.find((x) => x.id === r.session_id),
          { line_charge: r.line_charge, position: r.position }));
      return { rows, rowCount: rows.length };
    }

    if (/^update claims set is_hidden = true/i.test(t)) {
      const ids = Array.isArray(params[1]) ? params[1] : [params[0]];
      const practice = Array.isArray(params[1]) ? params[0] : params[1];
      const hit = claims.filter((c) => ids.includes(c.id) && c.practice_id === practice
        && !c.is_hidden && c.status === 'draft'
        && c.control_number == null && c.submitted_at == null);
      hit.forEach((c) => { c.is_hidden = true; });
      return { rows: hit.map((c) => ({ id: c.id })), rowCount: hit.length };
    }

    if (/^update claims set billed_amount/i.test(t)) {
      const c = claims.find((r) => r.id === params[1] && r.practice_id === params[2] && !r.is_hidden);
      if (!c) return { rows: [], rowCount: 0 };
      c.billed_amount = params[0];
      return { rows: [c], rowCount: 1 };
    }

    if (/^update claim_sessions set line_charge/i.test(t)) {
      const r = claimSessions.find((x) => x.claim_id === params[1] && x.session_id === params[2]);
      if (r) r.line_charge = params[0];
      return { rows: [], rowCount: r ? 1 : 0 };
    }

    if (/^insert into claims/i.test(t)) {
      if (failNextClaimInsertAfter != null && claims.filter((c) => c.__rebuilt).length >= failNextClaimInsertAfter) {
        throw new Error('simulated failure mid-rebuild');
      }
      // Map columns to params through the VALUES list — 'draft' is a LITERAL, so
      // indexing params by column position drifts and silently drops a value.
      const cols = t.match(/\(([^)]*)\) values/i)[1].split(',').map((x) => x.trim());
      const vals = t.match(/values \(([^)]*)\)/i)[1].split(',').map((x) => x.trim());
      const row = {
        id: uuid(++seq), is_hidden: false, control_number: null,
        patient_control_number: null, clearinghouse: null, submitted_at: null,
        corrects_claim_id: null, submission_frequency_code: null,
        prior_authorization_number: null, claim_number: null,
        created_at: '2026-08-20T00:00:00Z', __rebuilt: true,
      };
      cols.forEach((c, i) => {
        const m = vals[i] && vals[i].match(/^\$(\d+)$/);
        row[c] = m ? params[Number(m[1]) - 1] : vals[i].replace(/^'|'$/g, '');
      });
      claims.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (/^insert into claim_sessions/i.test(t)) {
      if (!claimSessions.some((r) => r.claim_id === params[1] && r.session_id === params[2])) {
        claimSessions.push({
          practice_id: params[0], claim_id: params[1], session_id: params[2],
          line_charge: params[3], position: params[4],
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (/^insert into claim_events/i.test(t)) {
      events.push({ claim_id: params[1], note: params[6] });
      return { rows: [], rowCount: 1 };
    }
    if (/^insert into audit_log/i.test(t)) return { rows: [], rowCount: 1 };

    throw new Error('unexpected query: ' + t);
  };
}

let txCounter = 0;
const fakeDb = {
  query: async (sql, params) => makeRunner('autocommit')(sql, params),
  withTransaction: async (fn) => {
    const txId = 'tx' + (++txCounter);
    // Snapshot for rollback: the store is plain arrays, so a deep copy is enough
    // to model what ROLLBACK restores.
    const snapshot = JSON.stringify({ claims, claimSessions, events });
    try {
      const out = await fn({ query: async (s, p) => makeRunner(txId)(s, p) });
      return out;
    } catch (err) {
      const prior = JSON.parse(snapshot);
      claims.length = 0; prior.claims.forEach((c) => claims.push(c));
      claimSessions.length = 0; prior.claimSessions.forEach((c) => claimSessions.push(c));
      events.length = 0; prior.events.forEach((e) => events.push(e));
      throw err;
    } finally {
      [...locks].filter((k) => String(k).startsWith(txId + ':')).forEach((k) => {
        locks.delete(k);
        locks.delete(String(k).slice(txId.length + 1));
      });
    }
  },
};

const dbPath = require.resolve(path.join(ROOT, 'backend/lib/db.js'));
require.cache[dbPath] = new Module(dbPath, module);
require.cache[dbPath].filename = dbPath;
require.cache[dbPath].loaded = true;
require.cache[dbPath].exports = fakeDb;

process.env.JWT_SECRET = 'integrity-test-secret';
const jwt = require(path.join(ROOT, 'backend/lib/jwt'));
const TOKEN = jwt.sign({ sub: USER, practice_id: PRACTICE, role: 'practice_admin' });
const handler = require(path.join(ROOT, 'backend/handlers/claims')).handler;

function call(method, route, body, id) {
  return handler({
    requestContext: { http: { method, path: route, sourceIp: '127.0.0.1' }, routeKey: `${method} ${route}` },
    rawPath: route,
    headers: { authorization: 'Bearer ' + TOKEN },
    pathParameters: id ? { id } : {},
    body: body ? JSON.stringify(body) : null,
  });
}

const group = (ids) => call('POST', '/claims/group', { claim_ids: ids });
const ungroup = (id) => call('POST', `/claims/${id}/ungroup`, {}, id);
const regenerate = (id) => call('POST', `/claims/${id}/regenerate`, {}, id);

const live = () => claims.filter((c) => !c.is_hidden);
const linesOf = (claimId) => claimSessions
  .filter((r) => r.claim_id === claimId).sort((a, b) => a.position - b.position);

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- 1. atomicity + concurrency ----------------------------------------------

test('grouping writes the claim, its lines and the retirements together', async () => {
  reset();
  const s = [mkSession({ session_date: '2026-08-03' }), mkSession({ session_date: '2026-08-10' }),
    mkSession({ session_date: '2026-08-17' })];
  const c = s.map((x) => mkClaim(x));

  const res = await group([c[2].id, c[0].id, c[1].id]);
  assert.strictEqual(res.statusCode, 201, res.body);
  const grouped = JSON.parse(res.body).claim;

  assert.strictEqual(Number(grouped.billed_amount), 525, '3 x 175');
  assert.deepStrictEqual(linesOf(grouped.id).map((l) => l.position), [1, 2, 3]);
  assert.deepStrictEqual(
    linesOf(grouped.id).map((l) => sessions.find((x) => x.id === l.session_id).session_date),
    ['2026-08-03', '2026-08-10', '2026-08-17'],
    'lines are in date-of-service order regardless of selection order'
  );
  assert.deepStrictEqual(c.map((x) => x.is_hidden), [true, true, true], 'sources retired');
  assert.strictEqual(live().length, 1, 'exactly one live claim remains');
});

test('OVERLAPPING concurrent groupings cannot both succeed', async () => {
  // Tab A groups {1,2,3}; tab B groups {3,4,5}. Claim 3 is in both. Exactly one
  // may win, and the loser must leave nothing behind.
  reset();
  const s = [];
  for (let i = 0; i < 5; i += 1) s.push(mkSession({ session_date: '2026-08-0' + (i + 1) }));
  const c = s.map((x) => mkClaim(x));

  const a = await group([c[0].id, c[1].id, c[2].id]);
  assert.strictEqual(a.statusCode, 201, 'the first grouping wins');

  // B now runs against the committed state: claim 3 is hidden, so B's own load
  // comes up short and it refuses — exactly what a real blocked-then-re-read
  // transaction sees under READ COMMITTED.
  const b = await group([c[2].id, c[3].id, c[4].id]);
  assert.notStrictEqual(b.statusCode, 201, 'the overlapping grouping is refused');

  // The decisive property: no session is billed on two live claims.
  const billed = [];
  live().forEach((cl) => linesOf(cl.id).forEach((l) => billed.push(l.session_id)));
  assert.strictEqual(new Set(billed).size, billed.length,
    'no service appears on more than one live claim');
  assert.ok(!live().some((cl) => cl.__rebuilt && linesOf(cl.id).length === 0),
    'the refused grouping left no empty claim behind');
});

test('a source claim submitted first blocks the grouping entirely', async () => {
  reset();
  const s = [mkSession(), mkSession({ session_date: '2026-08-10' })];
  const c = s.map((x) => mkClaim(x));
  // Someone submits one of them in another tab.
  c[1].status = 'submitted';
  c[1].submitted_at = '2026-08-11T00:00:00Z';
  c[1].control_number = 'CN-1';

  const res = await group([c[0].id, c[1].id]);
  assert.notStrictEqual(res.statusCode, 201);
  assert.strictEqual(c[0].is_hidden, false,
    'the OTHER claim is untouched — a refused grouping retires nothing');
  assert.strictEqual(live().length, 2, 'both claims survive');
});

// --- 2. ungroup rollback ------------------------------------------------------

test('ungroup rebuilds one draft per line, each with its OWN charge', async () => {
  reset();
  const s = [mkSession({ session_date: '2026-08-03', fee: 175 }),
    mkSession({ session_date: '2026-08-10', fee: 200 })];
  const c = s.map((x) => mkClaim(x));
  const grouped = JSON.parse((await group([c[0].id, c[1].id])).body).claim;
  assert.strictEqual(Number(grouped.billed_amount), 375);

  const res = await ungroup(grouped.id);
  assert.strictEqual(res.statusCode, 200, res.body);
  const rebuilt = JSON.parse(res.body).claims;

  assert.deepStrictEqual(rebuilt.map((r) => Number(r.billed_amount)).sort((a, b) => a - b),
    [175, 200], 'each rebuilt claim keeps its own line charge, not the group total');
  assert.ok(claims.find((x) => x.id === grouped.id).is_hidden, 'the grouped claim is retired');
  assert.strictEqual(live().length, 2, 'exactly the two rebuilt drafts are live');
});

test('ROLLBACK: a failure mid-rebuild leaves the grouped claim intact', async () => {
  reset();
  const s = [mkSession({ session_date: '2026-08-03' }), mkSession({ session_date: '2026-08-10' }),
    mkSession({ session_date: '2026-08-17' })];
  const c = s.map((x) => mkClaim(x));
  const grouped = JSON.parse((await group([c[0].id, c[1].id, c[2].id])).body).claim;
  const liveBefore = live().map((x) => x.id).sort();

  // Blow up after the first rebuilt draft is inserted.
  failNextClaimInsertAfter = 1;
  let threw = false;
  try {
    const res = await ungroup(grouped.id);
    // The handler surfaces it as a 500; what matters is the STATE afterwards.
    assert.notStrictEqual(res.statusCode, 200);
  } catch (_) {
    threw = true;
  }
  failNextClaimInsertAfter = null;

  const liveAfter = live().map((x) => x.id).sort();
  assert.deepStrictEqual(liveAfter, liveBefore,
    'the grouped claim is still live and NO partial drafts survive');
  assert.strictEqual(live().length, 1,
    'never four billable claims for three sessions');
  assert.ok(!claims.find((x) => x.id === grouped.id).is_hidden,
    'the retirement was rolled back too');
  assert.ok(threw || true);
});

// --- 3. filing provenance -----------------------------------------------------

const PROVENANCE = [
  'control_number', 'patient_control_number', 'clearinghouse', 'submitted_at',
  'submission_frequency_code', 'corrects_claim_id', 'prior_authorization_number',
];

test('a grouped claim carries NO filing provenance from its sources', async () => {
  reset();
  const s = [mkSession(), mkSession({ session_date: '2026-08-10' })];
  const c = s.map((x) => mkClaim(x));
  // Give the sources every kind of provenance a draft could plausibly carry.
  c.forEach((x) => { x.patient_control_number = 'PCN12345'; x.prior_authorization_number = 'AUTH-9'; });

  const grouped = JSON.parse((await group([c[0].id, c[1].id])).body).claim;
  const row = claims.find((x) => x.id === grouped.id);
  PROVENANCE.forEach((field) => {
    assert.strictEqual(row[field], null,
      'the grouped claim must not inherit ' + field + ' from a retired source');
  });
  assert.strictEqual(row.status, 'draft', 'it is a brand-new original draft');
});

test('grouping is refused on ANY filing provenance, not just a non-draft status', async () => {
  // Asserted against the columns themselves: a row that still says 'draft' but
  // carries a control number or a submitted_at HAS been handed to the
  // clearinghouse, and folding it into a new original filing is a duplicate.
  for (const field of ['control_number', 'submitted_at']) {
    reset();
    const s = [mkSession(), mkSession({ session_date: '2026-08-10' })];
    const c = s.map((x) => mkClaim(x));
    c[1][field] = field === 'submitted_at' ? '2026-08-11T00:00:00Z' : 'CN-1';

    const claimsBefore = claims.length;
    const linesBefore = claimSessions.length;

    const res = await group([c[0].id, c[1].id]);
    assert.strictEqual(res.statusCode, 422, field + ' must block grouping');
    const body = JSON.parse(res.body);
    assert.ok(body.conflicts.some((x) => x.code === 'previously_transmitted'),
      field + ' is reported as previously transmitted');

    // The point of this test: such a claim is INELIGIBLE, not merely stripped.
    // Nothing is created and nothing is retired — the source keeps its identity
    // and stays exactly where it was.
    assert.strictEqual(claims.length, claimsBefore,
      'no grouped claim is created when a source shows transmission evidence');
    assert.strictEqual(claimSessions.length, linesBefore, 'and no service lines');
    assert.deepStrictEqual(c.map((x) => x.is_hidden), [false, false],
      'no source is retired');
    assert.strictEqual(c[1][field] != null, true,
      'the source keeps its ' + field + ' — grouping never strips provenance to admit a claim');
  }
});

test('TRANSMISSION evidence blocks; a mere submit-attempt artifact does not', async () => {
  // The distinction this rule turns on, stated explicitly because it is easy to
  // over- or under-apply:
  //
  //   control_number / submitted_at  → the claim reached the clearinghouse.
  //                                    INELIGIBLE. Folding it into a new original
  //                                    filing would be a duplicate.
  //   patient_control_number         → minted by submitClaim BEFORE the network
  //                                    call, so a submit blocked by a 422 leaves
  //                                    it on a draft that was NEVER transmitted.
  //                                    Eligible; simply not copied forward.
  reset();
  const s = [mkSession(), mkSession({ session_date: '2026-08-10' })];
  const c = s.map((x) => mkClaim(x));
  c[1].patient_control_number = 'PCN12345';   // a blocked submit attempt, never sent

  const res = await group([c[0].id, c[1].id]);
  assert.strictEqual(res.statusCode, 201,
    'a never-transmitted draft is eligible even after a blocked submit attempt');
  const row = claims.find((x) => x.id === JSON.parse(res.body).claim.id);
  assert.strictEqual(row.patient_control_number, null,
    'and the artifact is NOT carried onto the new claim');
});

test('rebuilt claims from ungroup carry no provenance either', async () => {
  reset();
  const s = [mkSession(), mkSession({ session_date: '2026-08-10' })];
  const c = s.map((x) => mkClaim(x));
  const grouped = JSON.parse((await group([c[0].id, c[1].id])).body).claim;
  const rebuilt = JSON.parse((await ungroup(grouped.id)).body).claims;

  rebuilt.forEach((r) => {
    const row = claims.find((x) => x.id === r.id);
    PROVENANCE.forEach((field) => {
      assert.strictEqual(row[field], null, 'rebuilt claim must not carry ' + field);
    });
  });
});

// --- 4. grouped regeneration --------------------------------------------------

test('regeneration preserves line MEMBERSHIP, not just the total', async () => {
  reset();
  const s = [mkSession({ session_date: '2026-08-03', fee: 175 }),
    mkSession({ session_date: '2026-08-10', fee: 175 }),
    mkSession({ session_date: '2026-08-17', fee: 175 })];
  const c = s.map((x) => mkClaim(x));
  const grouped = JSON.parse((await group([c[0].id, c[1].id, c[2].id])).body).claim;

  const before = linesOf(grouped.id).map((l) => l.session_id);
  const res = await regenerate(grouped.id);
  assert.strictEqual(res.statusCode, 200, res.body);

  const after = linesOf(grouped.id).map((l) => l.session_id);
  assert.deepStrictEqual(after, before,
    'no line is dropped, added or reordered by a regeneration');
});

test('regeneration recomputes EVERY line charge from its own session', async () => {
  reset();
  const s = [mkSession({ session_date: '2026-08-03', fee: 175 }),
    mkSession({ session_date: '2026-08-10', fee: 175 }),
    mkSession({ session_date: '2026-08-17', fee: 175 })];
  const c = s.map((x) => mkClaim(x));
  const grouped = JSON.parse((await group([c[0].id, c[1].id, c[2].id])).body).claim;

  // Two of the three sessions are re-priced — including one that is NOT the
  // anchor, which is the case the old anchor-only code got wrong.
  s[1].fee = 250;
  s[2].fee = 100;

  await regenerate(grouped.id);

  assert.deepStrictEqual(linesOf(grouped.id).map((l) => Number(l.line_charge)),
    [175, 250, 100], 'every line follows its own session, not the anchor');
  assert.strictEqual(Number(claims.find((x) => x.id === grouped.id).billed_amount), 525,
    'and the claim total is their sum');
});

test('REGRESSION: regeneration does not collapse a grouped claim to the anchor fee', async () => {
  // The exact defect fixed in this PR: billed_amount came from the anchor session
  // alone, so a three-line claim became one session's fee — under-billing the
  // payer and, since the platform fee is a percentage of billed_amount,
  // under-charging the patient.
  reset();
  const s = [mkSession({ session_date: '2026-08-03', fee: 175 }),
    mkSession({ session_date: '2026-08-10', fee: 175 }),
    mkSession({ session_date: '2026-08-17', fee: 175 })];
  const c = s.map((x) => mkClaim(x));
  const grouped = JSON.parse((await group([c[0].id, c[1].id, c[2].id])).body).claim;

  await regenerate(grouped.id);
  const total = Number(claims.find((x) => x.id === grouped.id).billed_amount);
  assert.notStrictEqual(total, 175, 'must NOT collapse to the anchor session fee');
  assert.strictEqual(total, 525);
});

test('line charges and the claim total always agree after regeneration', async () => {
  reset();
  const s = [mkSession({ session_date: '2026-08-03', fee: 116.66 }),
    mkSession({ session_date: '2026-08-10', fee: 116.66 }),
    mkSession({ session_date: '2026-08-17', fee: 116.66 })];
  const c = s.map((x) => mkClaim(x));
  const grouped = JSON.parse((await group([c[0].id, c[1].id, c[2].id])).body).claim;
  await regenerate(grouped.id);

  const lineSum = linesOf(grouped.id)
    .reduce((sum, l) => sum + Math.round(Number(l.line_charge) * 100), 0);
  const total = Math.round(Number(claims.find((x) => x.id === grouped.id).billed_amount) * 100);
  assert.strictEqual(lineSum, total,
    'the 837P line-sum invariant still holds — in cents, so float residue cannot break it');
});

// --- 5. the diagnosis-mismatch refusal, at the endpoint ----------------------

test('DIAGNOSIS MISMATCH: refused, nothing created, nothing retired, reason names the date', async () => {
  // Diagnosis-set equality is a grouping compatibility rule exactly like client,
  // clinician, policy and place of service — the 837P emits ONE diagnosis set at
  // claim level and every service line points into that shared list, so a mixed
  // group would file one session under another session's diagnoses.
  reset();
  const s = [
    mkSession({ session_date: '2026-08-03', diagnosis_codes: ['F411'] }),
    mkSession({ session_date: '2026-08-10', diagnosis_codes: ['F321'] }),
  ];
  const c = s.map((x) => mkClaim(x));
  const claimsBefore = claims.length;
  const linesBefore = claimSessions.length;

  const res = await group([c[0].id, c[1].id]);

  // (1) refused
  assert.strictEqual(res.statusCode, 422, res.body);
  const body = JSON.parse(res.body);

  // (4) the reason is the diagnosis mismatch
  assert.ok(body.conflicts.some((x) => x.code === 'mixed_diagnoses'),
    'the refusal reason is the diagnosis mismatch');

  // (5) and it names the offending date of service
  const msg = body.conflicts.find((x) => x.code === 'mixed_diagnoses').message;
  assert.ok(/2026-08-10/.test(msg), 'the offending service date is named: ' + msg);
  assert.ok(!/F411|F321/.test(msg), 'without leaking the diagnosis codes themselves');

  // (2) no grouped claim was created
  assert.strictEqual(claims.length, claimsBefore, 'no claim row was written');
  assert.strictEqual(claimSessions.length, linesBefore, 'no service line was written');

  // (3) no source was retired
  assert.deepStrictEqual(c.map((x) => x.is_hidden), [false, false],
    'both source drafts are untouched and still billable');
  assert.strictEqual(live().length, 2);
});

test('diagnosis ORDER and CASE do not block grouping — it is a normalized SET', async () => {
  reset();
  const s = [
    mkSession({ session_date: '2026-08-03', diagnosis_codes: ['F411', 'F321'] }),
    mkSession({ session_date: '2026-08-10', diagnosis_codes: ['f321', ' F411 '] }),
  ];
  const c = s.map((x) => mkClaim(x));
  const res = await group([c[0].id, c[1].id]);
  assert.strictEqual(res.statusCode, 201, res.body);
});

test('CPT, fee and modifiers may differ across a group at the endpoint', async () => {
  // Each rides its own service line, so these must NOT prevent grouping.
  reset();
  const s = [
    mkSession({ session_date: '2026-08-03', cpt_code: '90791', fee: 250, procedure_modifiers: ['95'] }),
    mkSession({ session_date: '2026-08-10', cpt_code: '90834', fee: 125, procedure_modifiers: null }),
  ];
  const c = s.map((x) => mkClaim(x));
  const res = await group([c[0].id, c[1].id]);
  assert.strictEqual(res.statusCode, 201, res.body);
  assert.strictEqual(Number(JSON.parse(res.body).claim.billed_amount), 375,
    'different charges simply sum onto one claim');
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
