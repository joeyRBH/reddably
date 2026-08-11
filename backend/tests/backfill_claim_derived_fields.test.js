'use strict';

// Unit test — the one-time operator backfill
// (backend/scripts/backfill-claim-derived-fields.js).
//
// The script re-derives two stranded claim fields exactly the way the app does:
// insurance_record_id via lib/claims.primaryInsuranceForClient (the real helper —
// only the DB underneath it is faked here) and billed_amount from the session fee,
// as regenerateClaim does. What must hold, and what this pins down:
//
//   * DRY RUN writes NOTHING, and counts correctly.
//   * --apply fills ONLY missing values — an explicitly-set insurance link or
//     billed amount is never overwritten (the UPDATE coalesces).
//   * a submitted (non-regeneratable) claim is never touched, at plan time AND at
//     write time (the UPDATE re-checks the status).
//   * a client with no primary insurance record is skipped, left null, and counted.
//   * claims.status is never written.
//   * one audit_log row per claim changed, with field NAMES only (no PHI).
//   * a second --apply run after the first reports zero changes and writes nothing.
//
// No DB, no network: lib/db.js is replaced in the require cache with an in-memory
// fixture that answers the script's four statements.
//
//   node backend/tests/backfill_claim_derived_fields.test.js

const assert = require('node:assert');
const path = require('node:path');

function mock(rel, exports) {
  const resolved = require.resolve(path.join(__dirname, '..', rel));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const PRACTICE_ID = '11111111-1111-4111-8111-111111111111';

// --- fixtures ----------------------------------------------------------------
//
//   c-draft-both      draft, missing both fields, client has coverage + fee   → both filled
//   c-draft-ins-only  draft, missing insurance only (amount explicitly set)   → insurance only
//   c-denied-fee-only denied, missing amount only (insurance explicitly set)  → amount only
//   c-submitted       submitted, missing both                                 → never touched
//   c-no-coverage     draft, missing both, client has NO insurance record     → amount only
//   c-no-fee          draft, missing amount, session fee is null              → nothing

function freshState() {
  return {
    claims: [
      {
        id: 'c-draft-both', practice_id: PRACTICE_ID, client_id: 'cl-1', session_id: 's-1',
        status: 'draft', insurance_record_id: null, billed_amount: null, session_fee: '150.00',
        is_hidden: false,
      },
      {
        id: 'c-draft-ins-only', practice_id: PRACTICE_ID, client_id: 'cl-1', session_id: 's-2',
        status: 'draft', insurance_record_id: null, billed_amount: '999.00', session_fee: '150.00',
        is_hidden: false,
      },
      {
        id: 'c-denied-fee-only', practice_id: PRACTICE_ID, client_id: 'cl-1', session_id: 's-3',
        status: 'denied', insurance_record_id: 'ins-EXPLICIT', billed_amount: null, session_fee: '200.00',
        is_hidden: false,
      },
      {
        id: 'c-submitted', practice_id: PRACTICE_ID, client_id: 'cl-1', session_id: 's-4',
        status: 'submitted', insurance_record_id: null, billed_amount: null, session_fee: '150.00',
        is_hidden: false,
      },
      {
        id: 'c-no-coverage', practice_id: PRACTICE_ID, client_id: 'cl-nocov', session_id: 's-5',
        status: 'draft', insurance_record_id: null, billed_amount: null, session_fee: '175.00',
        is_hidden: false,
      },
      {
        id: 'c-no-fee', practice_id: PRACTICE_ID, client_id: 'cl-1', session_id: 's-6',
        status: 'draft', insurance_record_id: 'ins-EXPLICIT', billed_amount: null, session_fee: null,
        is_hidden: false,
      },
      // Nothing missing — counted as "already set", never in the plan.
      {
        id: 'c-complete', practice_id: PRACTICE_ID, client_id: 'cl-1', session_id: 's-7',
        status: 'draft', insurance_record_id: 'ins-1', billed_amount: '150.00', session_fee: '150.00',
        is_hidden: false,
      },
    ],
    // cl-1 has a primary record; cl-nocov has none.
    insurance: [
      { id: 'ins-1', practice_id: PRACTICE_ID, client_id: 'cl-1', is_primary: true, is_hidden: false },
    ],
    auditRows: [],
    writes: 0,          // every INSERT/UPDATE the fake DB sees
    rolledBack: false,
    committed: false,
  };
}

let state = freshState();

function byId(id) {
  return state.claims.find((c) => c.id === id) || null;
}

// The fake query runner: the four statements the script issues. Anything else is
// an assertion failure, so a query added later can't silently no-op.
async function fakeQuery(sql, params) {
  const text = String(sql);

  if (/from claims c/i.test(text)) {
    const rows = state.claims
      .filter((c) => !c.is_hidden && (c.insurance_record_id == null || c.billed_amount == null))
      .map((c) => ({
        id: c.id, practice_id: c.practice_id, client_id: c.client_id, session_id: c.session_id,
        status: c.status, insurance_record_id: c.insurance_record_id,
        billed_amount: c.billed_amount, session_fee: c.session_fee,
      }));
    return { rows, rowCount: rows.length };
  }

  if (/count\(\*\)::int as n/i.test(text) && /from claims/i.test(text)) {
    const n = state.claims.filter(
      (c) => !c.is_hidden && c.insurance_record_id != null && c.billed_amount != null
    ).length;
    return { rows: [{ n }], rowCount: 1 };
  }

  // primaryInsuranceForClient (the REAL helper from lib/claims.js).
  if (/from insurance_records/i.test(text)) {
    const [practiceId, clientId] = params;
    const rows = state.insurance.filter(
      (r) => r.practice_id === practiceId && r.client_id === clientId && !r.is_hidden
    );
    return { rows: rows.slice(0, 1), rowCount: Math.min(rows.length, 1) };
  }

  if (/^\s*update claims/i.test(text)) {
    state.writes += 1;
    const [insuranceRecordId, billedAmount, id, practiceId, statuses] = params;
    const claim = byId(id);
    // Mirror the WHERE clause exactly — including the status re-check.
    if (
      !claim || claim.practice_id !== practiceId || claim.is_hidden ||
      !statuses.includes(claim.status) ||
      !(claim.insurance_record_id == null || claim.billed_amount == null)
    ) {
      return { rows: [], rowCount: 0 };
    }
    // coalesce(): only a null is filled.
    if (claim.insurance_record_id == null && insuranceRecordId != null) {
      claim.insurance_record_id = insuranceRecordId;
    }
    if (claim.billed_amount == null && billedAmount != null) {
      claim.billed_amount = billedAmount;
    }
    return {
      rows: [{ id: claim.id, insurance_record_id: claim.insurance_record_id, billed_amount: claim.billed_amount }],
      rowCount: 1,
    };
  }

  if (/insert into audit_log/i.test(text)) {
    state.writes += 1;
    state.auditRows.push({
      practice_id: params[0], actor_user_id: params[1], actor_type: params[2],
      action: params[3], resource_type: params[4], resource_id: params[5],
      metadata: params[9],
    });
    return { rows: [], rowCount: 1 };
  }

  throw new Error('unexpected SQL in backfill test: ' + text.trim().slice(0, 80));
}

mock('lib/db.js', {
  query: fakeQuery,
  withTransaction: async (fn) => {
    try {
      const out = await fn({ query: fakeQuery });
      state.committed = true;
      return out;
    } catch (err) {
      state.rolledBack = true;
      throw err;
    }
  },
});

const backfill = require(path.join(__dirname, '..', 'scripts', 'backfill-claim-derived-fields.js'));

// --- 1. DRY RUN: no writes, correct counts -----------------------------------

(async function dryRun() {
  const before = JSON.stringify(state.claims);
  const { plan, applied } = await backfill.run({ apply: false });

  assert.strictEqual(applied, null, 'dry run reports no applied writes');
  assert.strictEqual(state.writes, 0, 'DRY RUN must issue no UPDATE and no INSERT');
  assert.strictEqual(JSON.stringify(state.claims), before, 'DRY RUN must not mutate any claim');

  const ids = plan.changes.map((c) => c.id).sort();
  assert.deepStrictEqual(
    ids,
    ['c-denied-fee-only', 'c-draft-both', 'c-draft-ins-only', 'c-no-coverage'].sort(),
    'exactly the fillable claims are planned'
  );

  const withInsurance = plan.changes.filter((c) => 'insuranceRecordId' in c).map((c) => c.id).sort();
  assert.deepStrictEqual(withInsurance, ['c-draft-both', 'c-draft-ins-only'],
    'insurance is attached only where it is missing AND the client has a primary record');

  const withBilled = plan.changes.filter((c) => 'billedAmount' in c).map((c) => c.id).sort();
  assert.deepStrictEqual(withBilled, ['c-denied-fee-only', 'c-draft-both', 'c-no-coverage'].sort(),
    'billed_amount is set only where it is missing AND the session has a fee');

  assert.strictEqual(plan.skipped.already_set, 1, 'one claim already has both fields');
  assert.strictEqual(plan.skipped.non_regeneratable, 1, 'the submitted claim is skipped');
  assert.strictEqual(plan.skipped.no_primary_insurance, 1, 'the coverage-less client is skipped');
  assert.strictEqual(plan.skipped.no_session_fee, 1, 'the fee-less session is skipped');

  // The summary is operator-facing: ids only, never a client name or an amount.
  const summary = backfill.formatSummary(plan, { applied: null });
  assert.ok(/DRY RUN: no writes were made/.test(summary));
  assert.ok(summary.includes('c-draft-both'), 'affected ids are listed');
  assert.ok(!/150\.00|999\.00/.test(summary), 'the summary carries no monetary values');
})()

  // --- 2. --apply: fills only what is missing --------------------------------

  .then(async function apply() {
    const { plan, applied } = await backfill.run({ apply: true });

    assert.ok(state.committed, 'the write path runs inside a transaction');
    assert.strictEqual(plan.changes.length, 4);
    assert.deepStrictEqual(
      applied.slice().sort(),
      ['c-denied-fee-only', 'c-draft-both', 'c-draft-ins-only', 'c-no-coverage'].sort(),
      'every planned claim was written'
    );

    // Both fields derived.
    assert.strictEqual(byId('c-draft-both').insurance_record_id, 'ins-1');
    assert.strictEqual(byId('c-draft-both').billed_amount, '150.00');

    // An explicitly-set billed amount survives an insurance-only fill.
    assert.strictEqual(byId('c-draft-ins-only').insurance_record_id, 'ins-1');
    assert.strictEqual(byId('c-draft-ins-only').billed_amount, '999.00',
      'an explicitly-set billed_amount is NEVER overwritten');

    // An explicitly-set insurance link survives an amount-only fill.
    assert.strictEqual(byId('c-denied-fee-only').insurance_record_id, 'ins-EXPLICIT',
      'an explicitly-set insurance link is NEVER overwritten');
    assert.strictEqual(byId('c-denied-fee-only').billed_amount, '200.00');

    // Submitted claims are untouchable.
    assert.strictEqual(byId('c-submitted').insurance_record_id, null,
      'a submitted claim never gets coverage attached');
    assert.strictEqual(byId('c-submitted').billed_amount, null,
      'a submitted claim never gets an amount set');
    assert.ok(!applied.includes('c-submitted'));

    // No primary insurance → left null, but the fee still lands.
    assert.strictEqual(byId('c-no-coverage').insurance_record_id, null,
      'coverage is never invented for a client with no primary record');
    assert.strictEqual(byId('c-no-coverage').billed_amount, '175.00');

    // No session fee → nothing at all.
    assert.strictEqual(byId('c-no-fee').billed_amount, null);
    assert.ok(!applied.includes('c-no-fee'));

    // Status is never written — the UPDATE has no status assignment at all.
    assert.strictEqual(byId('c-draft-both').status, 'draft');
    assert.strictEqual(byId('c-denied-fee-only').status, 'denied');
    assert.strictEqual(byId('c-submitted').status, 'submitted');

    // One audit row per claim changed, field NAMES only.
    assert.strictEqual(state.auditRows.length, applied.length, 'one audit row per claim written');
    state.auditRows.forEach((row) => {
      assert.strictEqual(row.action, backfill.AUDIT_ACTION);
      assert.strictEqual(row.resource_type, 'claim');
      assert.strictEqual(row.actor_type, 'system', 'an operator-run backfill has no user actor');
      assert.strictEqual(row.actor_user_id, null);
      assert.strictEqual(row.practice_id, PRACTICE_ID);
      const meta = JSON.parse(row.metadata);
      meta.fields_changed.forEach((f) => {
        assert.ok(['insurance_record_id', 'billed_amount'].includes(f), 'field names only: ' + f);
      });
      assert.ok(!/\d+\.\d\d/.test(row.metadata), 'no monetary values in audit metadata');
    });
    const auditedIds = state.auditRows.map((r) => r.resource_id).sort();
    assert.deepStrictEqual(auditedIds, applied.slice().sort());
    assert.ok(!auditedIds.includes('c-submitted'));
  })

  // --- 3. idempotency: a second --apply changes nothing ----------------------

  .then(async function secondApply() {
    const writesBefore = state.writes;
    const auditBefore = state.auditRows.length;
    const snapshot = JSON.stringify(state.claims);

    const { plan, applied } = await backfill.run({ apply: true });

    assert.strictEqual(plan.changes.length, 0, 'a second run finds nothing left to fill');
    assert.strictEqual(applied.length, 0, 'a second run writes no claims');
    assert.strictEqual(state.writes, writesBefore, 'a second run issues no UPDATE and no INSERT');
    assert.strictEqual(state.auditRows.length, auditBefore, 'a second run adds no audit rows');
    assert.strictEqual(JSON.stringify(state.claims), snapshot, 'a second run mutates nothing');

    // What is left is exactly the rows a human has to resolve.
    assert.strictEqual(plan.skipped.non_regeneratable, 1);
    assert.strictEqual(plan.skipped.no_primary_insurance, 1);
    assert.strictEqual(plan.skipped.no_session_fee, 1);

    const summary = backfill.formatSummary(plan, { applied });
    assert.ok(/affected claim ids: \(none\)/.test(summary), 'the summary says plainly that nothing changed');
  })

  // --- 4. a dry run after --apply also reports zero ---------------------------

  .then(async function dryRunAfterApply() {
    const { plan } = await backfill.run({ apply: false });
    assert.strictEqual(plan.changes.length, 0, 'the post-apply DRY RUN reports zero changes');

    console.log('backfill_claim_derived_fields.test.js: all assertions passed');
  })

  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
