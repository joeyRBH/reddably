'use strict';

// Unit test — the one-off claim-backfill Lambda
// (backend/handlers/backfill_claim_fields.js).
//
// The handler owns no derivation: the script is the implementation, and this is
// the invocation surface that carries a connection string to it from inside the
// VPC. What must hold is the SAFETY of that surface:
//
//   * dry run is the DEFAULT — a bare invoke (no payload, {}, null) writes nothing;
//   * writes require apply === true as a real BOOLEAN. "true", 1, "yes", {apply:{}}
//     are all dry runs — a mis-typed payload must fail toward doing nothing;
//   * a failure returns { ok: false } instead of throwing, and never puts the
//     connection string in the message or the logs;
//   * the returned summary/counts carry claim ids only — no names, no amounts.
//
// The script module is replaced in the require cache, so this test asserts what
// the handler ASKS the script to do; backfill_claim_derived_fields.test.js covers
// what the script actually does.
//
//   node backend/tests/backfill_lambda.test.js

const assert = require('node:assert');
const path = require('node:path');

function mock(rel, exports) {
  const resolved = require.resolve(path.join(__dirname, '..', rel));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const PRACTICE_ID = '11111111-1111-4111-8111-111111111111';
const SECRET_URL = 'postgres://user:sup3rs3cret@db.internal:5432/reddably';

// What the script would report: two claims fillable, one of each skip.
function fakePlan() {
  return {
    changes: [
      { id: 'claim-a', practiceId: PRACTICE_ID, insuranceRecordId: 'ins-1', billedAmount: '150.00' },
      { id: 'claim-b', practiceId: PRACTICE_ID, billedAmount: '200.00' },
    ],
    skipped: { already_set: 7, non_regeneratable: 3, no_primary_insurance: 1, no_session_fee: 2 },
  };
}

const script = { calls: [], mode: 'ok' };
mock('scripts/backfill-claim-derived-fields.js', {
  run: async (opts) => {
    script.calls.push(opts);
    if (script.mode === 'throw') throw new Error('connection refused for ' + SECRET_URL);
    const plan = fakePlan();
    return { plan, applied: opts && opts.apply ? plan.changes.map((c) => c.id) : null };
  },
  formatSummary: (plan, o) => (o && o.applied ? 'APPLIED ' : 'DRY RUN ') + plan.changes.length,
});

mock('lib/db.js', { query: async () => ({ rows: [], rowCount: 0 }), withTransaction: async (fn) => fn({}) });

// DATABASE_URL present → loadDatabaseUrl short-circuits and @aws-sdk/client-ssm
// (runtime-provided, not a dependency) is never required. That lazy require is
// what makes this handler testable at all.
process.env.DATABASE_URL = SECRET_URL;

const handlerModule = require(path.join(__dirname, '..', 'handlers', 'backfill_claim_fields.js'));
const { handler, shouldApply } = handlerModule;

// Capture console so we can assert nothing leaks the connection string.
const logged = [];
const realLog = console.log;
const realError = console.error;
console.log = (...a) => logged.push(a.join(' '));
console.error = (...a) => logged.push(a.join(' '));

function reset(mode) {
  script.calls.length = 0;
  script.mode = mode || 'ok';
  logged.length = 0;
}

(async () => {
  // --- 1. dry run is the default -------------------------------------------

  for (const event of [undefined, null, {}, { apply: false }]) {
    reset();
    const res = await handler(event);
    assert.strictEqual(res.ok, true, 'the invoke succeeds');
    assert.strictEqual(res.applied, false, `payload ${JSON.stringify(event)} is a DRY RUN`);
    assert.deepStrictEqual(script.calls, [{ apply: false }], 'the script is asked for a dry run');
    assert.strictEqual(res.counts.written, 0, 'nothing written');
  }

  // --- 2. only a real boolean true writes -----------------------------------

  // The whole point: a mis-typed payload must fail toward doing NOTHING.
  for (const bad of ['true', 'TRUE', 1, 'yes', {}, [], 'apply']) {
    reset();
    const res = await handler({ apply: bad });
    assert.strictEqual(res.applied, false,
      `apply: ${JSON.stringify(bad)} must NOT write — only a boolean true does`);
    assert.deepStrictEqual(script.calls, [{ apply: false }]);
  }
  assert.strictEqual(shouldApply({ apply: true }), true, 'a real boolean true applies');
  assert.strictEqual(shouldApply({ apply: 'true' }), false, 'the string does not');

  reset();
  const applied = await handler({ apply: true });
  assert.strictEqual(applied.applied, true, '{apply:true} writes');
  assert.deepStrictEqual(script.calls, [{ apply: true }], 'and the script is asked to apply');
  assert.strictEqual(applied.counts.written, 2, 'reporting what was written');

  // --- 3. the reported shape -------------------------------------------------

  reset();
  const dry = await handler({});
  assert.strictEqual(dry.counts.would_attach_insurance, 1, 'one claim would get coverage');
  assert.strictEqual(dry.counts.would_set_billed_amount, 2, 'two would get an amount');
  assert.strictEqual(dry.counts.affected, 2);
  assert.deepStrictEqual(dry.counts.skipped,
    { already_set: 7, non_regeneratable: 3, no_primary_insurance: 1, no_session_fee: 2 },
    'every skip bucket is carried through, so the operator sees what was left alone');
  assert.deepStrictEqual(dry.claim_ids, ['claim-a', 'claim-b'], 'ids only');
  assert.ok(dry.summary, 'the human-readable summary comes back too');

  // --- 4. failure is returned, not thrown, and leaks nothing -----------------

  reset('throw');
  const failed = await handler({});
  assert.strictEqual(failed.ok, false, 'a failure returns ok:false rather than throwing');
  assert.strictEqual(failed.applied, false);
  assert.ok(!/sup3rs3cret/.test(JSON.stringify(failed)),
    'the response never carries the connection string');
  assert.ok(!/sup3rs3cret/.test(logged.join('\n')),
    'and neither do the logs — the message is logged, not the URL');
  // Scrubbed, not swallowed: the operator still learns what went wrong.
  assert.match(failed.message, /connection refused/, 'the useful part of the error survives');
  assert.match(failed.message, /\[redacted\]/, 'and the DSN is replaced in place');

  // Nothing logged across any successful run carries credentials either.
  reset();
  await handler({ apply: true });
  assert.ok(!/sup3rs3cret/.test(logged.join('\n')), 'a successful run logs no credentials');

  console.log = realLog;
  console.error = realError;
  console.log('backfill_lambda.test.js: all assertions passed');
})().catch((err) => {
  console.log = realLog;
  console.error = realError;
  console.error(err);
  process.exit(1);
});
