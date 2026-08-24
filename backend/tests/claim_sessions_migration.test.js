'use strict';

// Migration 022 (claim_sessions) — safety properties, asserted against the SQL
// itself and against a model of its backfill.
//
// There is no Postgres in this suite, so this does two things it CAN do
// faithfully: read the migration text and assert the structural guarantees, and
// model the backfill's set semantics over a fixture that includes the case most
// likely to go wrong — a REPLACEMENT claim, which is a second claims row over a
// session another claim already bills.
//
// What it deliberately does NOT claim: that the DDL executes. That is what the
// documented apply-then-verify step against RDS is for, and the migration
// carries the verification queries.
//
//   node backend/tests/claim_sessions_migration.test.js

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATION = path.join(__dirname, '..', '..', 'db', 'migrations', '022_add_claim_sessions.sql');
const SCHEMA = path.join(__dirname, '..', '..', 'db', 'schema.sql');
const sql = fs.readFileSync(MIGRATION, 'utf8');
const schema = fs.readFileSync(SCHEMA, 'utf8');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- 1. additive and re-runnable ----------------------------------------------

test('the migration only ADDS — it drops and alters nothing', () => {
  assert.ok(/create table if not exists claim_sessions/i.test(sql),
    'the table creation is guarded');
  // The destructive verbs, none of which belong in an additive migration.
  [/\bdrop\s+table\b/i, /\bdrop\s+column\b/i, /\balter\s+column\b/i, /\bdelete\s+from\b/i,
    /\btruncate\b/i].forEach((re) => {
    assert.ok(!re.test(sql), 'migration must not contain ' + re);
  });
  // claims itself is not touched. session_id STAYS as the anchor; the whole
  // point is that this adds a relationship rather than moving one.
  assert.ok(!/alter table claims/i.test(sql),
    'the claims table is not altered — every existing join keeps working');
});

test('every statement is re-runnable', () => {
  assert.ok(/create index if not exists/i.test(sql), 'indexes are guarded');
  assert.ok(/where not exists/i.test(sql), 'the backfill is guarded');
  assert.ok(!/create index (?!if not exists)/i.test(sql), 'no unguarded index');
});

test('foreign keys follow the repo rule: RESTRICT protects records, CASCADE follows lifecycle', () => {
  assert.ok(/claim_id\s+uuid not null references claims \(id\) on delete cascade/i.test(sql),
    'a service line has no meaning without its claim (mirrors claim_events)');
  assert.ok(/session_id\s+uuid not null references sessions \(id\) on delete restrict/i.test(sql),
    'a session is a record in its own right and must survive its claim');
  assert.ok(/practice_id\s+uuid not null references practices \(id\) on delete restrict/i.test(sql),
    'practice scoping is carried, per the multi-tenancy rule');
});

test('uniqueness is (claim_id, session_id) and NOT session_id alone', () => {
  assert.ok(/unique \(claim_id, session_id\)/i.test(sql),
    'the same session must never appear twice on ONE claim');
  // The rule that a naive reading gets wrong. A replacement claim (frequency 7)
  // is a NEW claim over the SAME service, which claims have always allowed — a
  // unique index on session_id would make every replacement fail to insert.
  assert.ok(!/unique[^\n]*\(\s*session_id\s*\)/i.test(sql),
    'session_id alone must NOT be unique, or replacement claims break');
  assert.ok(!/create unique index[^\n]*claim_sessions \(session_id\)/i.test(sql));
});

test('schema.sql carries the same table and the same backfill', () => {
  // db/schema.sql is the source of truth and must not drift from the migration.
  assert.ok(/create table if not exists claim_sessions/i.test(schema));
  assert.ok(/unique \(claim_id, session_id\)/i.test(schema));
  assert.ok(/insert into claim_sessions[\s\S]*?where not exists/i.test(schema),
    'a fresh database applied from schema.sql gets the backfill too');
});

test('the deploy order is documented in the migration itself', () => {
  assert.ok(/MIGRATION FIRST, THEN CODE/i.test(sql), 'the ordering is stated');
  assert.ok(/information_schema|select count\(\*\) from claim_sessions/i.test(sql),
    'a concrete verification step is given, not just an instruction to verify');
});

// --- 2. the backfill's set semantics -----------------------------------------

// Model of:
//   insert into claim_sessions (practice_id, claim_id, session_id, line_charge, position)
//   select c.practice_id, c.id, c.session_id, c.billed_amount, 1
//     from claims c
//    where not exists (select 1 from claim_sessions cs where cs.claim_id = c.id);
function runBackfill(claims, existing) {
  const out = existing.slice();
  claims.forEach((c) => {
    if (out.some((r) => r.claim_id === c.id)) return;
    out.push({
      practice_id: c.practice_id, claim_id: c.id, session_id: c.session_id,
      line_charge: c.billed_amount, position: 1,
    });
  });
  return out;
}

const ORIGINAL = { id: 'claim-1', practice_id: 'p1', session_id: 'session-1', billed_amount: 175 };
// A replacement is a SEPARATE claims row pointing at the SAME session.
const REPLACEMENT = {
  id: 'claim-2', practice_id: 'p1', session_id: 'session-1', billed_amount: 175,
  corrects_claim_id: 'claim-1', submission_frequency_code: '7',
};
const OTHER = { id: 'claim-3', practice_id: 'p1', session_id: 'session-2', billed_amount: 200 };

test('every existing claim gets exactly one line', () => {
  const rows = runBackfill([ORIGINAL, REPLACEMENT, OTHER], []);
  assert.strictEqual(rows.length, 3, 'one row per claim');
  [ORIGINAL, REPLACEMENT, OTHER].forEach((c) => {
    const mine = rows.filter((r) => r.claim_id === c.id);
    assert.strictEqual(mine.length, 1, c.id + ' has exactly one line');
    assert.strictEqual(mine[0].session_id, c.session_id, c.id + ' bills its own session');
    assert.strictEqual(mine[0].line_charge, c.billed_amount,
      c.id + ' line charge is its claim total — for a 1:1 claim they ARE the same');
    assert.strictEqual(mine[0].position, 1);
  });
});

test('a REPLACEMENT claim is not treated as a duplicate of its original', () => {
  const rows = runBackfill([ORIGINAL, REPLACEMENT], []);
  const forSession = rows.filter((r) => r.session_id === 'session-1');
  assert.strictEqual(forSession.length, 2,
    'session-1 legitimately appears on both the original and its replacement');
  assert.strictEqual(new Set(forSession.map((r) => r.claim_id)).size, 2,
    'under two DIFFERENT claim ids, which is what (claim_id, session_id) permits');
  // And the constraint that IS enforced still holds.
  const key = (r) => r.claim_id + '|' + r.session_id;
  assert.strictEqual(new Set(rows.map(key)).size, rows.length,
    'no (claim_id, session_id) pair repeats');
});

test('re-running the backfill is a no-op', () => {
  const once = runBackfill([ORIGINAL, REPLACEMENT, OTHER], []);
  const twice = runBackfill([ORIGINAL, REPLACEMENT, OTHER], once);
  assert.deepStrictEqual(twice, once, 'idempotent — safe to apply repeatedly');
});

test('a claim that already has lines is left alone', () => {
  // A grouped claim created after the migration has three lines. Re-applying the
  // migration must not append a fourth pointing at its anchor session.
  const grouped = { id: 'claim-9', practice_id: 'p1', session_id: 'session-a', billed_amount: 525 };
  const existing = [
    { practice_id: 'p1', claim_id: 'claim-9', session_id: 'session-a', line_charge: 175, position: 1 },
    { practice_id: 'p1', claim_id: 'claim-9', session_id: 'session-b', line_charge: 175, position: 2 },
    { practice_id: 'p1', claim_id: 'claim-9', session_id: 'session-c', line_charge: 175, position: 3 },
  ];
  const rows = runBackfill([grouped], existing);
  assert.strictEqual(rows.filter((r) => r.claim_id === 'claim-9').length, 3,
    'the guard is per-CLAIM, so a grouped claim keeps exactly its own lines');
  assert.ok(!rows.some((r) => r.claim_id === 'claim-9' && r.line_charge === 525),
    'the group total never leaks in as a line charge');
});

test('after the backfill, every claim has a line — the one-code-path property', () => {
  const rows = runBackfill([ORIGINAL, REPLACEMENT, OTHER], []);
  [ORIGINAL, REPLACEMENT, OTHER].forEach((c) => {
    assert.ok(rows.some((r) => r.claim_id === c.id),
      c.id + ' has a line, so nothing has to branch on "grouped or legacy"');
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
