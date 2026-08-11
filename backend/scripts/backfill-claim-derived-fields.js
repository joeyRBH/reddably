'use strict';

// =============================================================================
// One-time operator backfill — re-derive the two claim fields that strand a claim
// =============================================================================
//
// Some existing claims were created before (or outside of) the paths that derive
// their session/coverage-linked fields, and sit in the workspace unable to move:
//
//   * insurance_record_id is null — no coverage attached, so the claim can never
//     be submitted; and
//   * billed_amount is null — no money on the claim.
//
// This script re-derives EXACTLY those two fields, the same way the app already
// does per claim, for claims that are still editable from their session:
//
//   * insurance_record_id → primaryInsuranceForClient() from lib/claims.js — the
//     same helper POST /claims (createClaim) uses to auto-pick coverage. If the
//     client has no primary (non-hidden) insurance record, the claim is SKIPPED
//     and left null; this script never invents coverage.
//   * billed_amount → the session's fee, exactly as regenerateClaim() derives it
//     (backend/handlers/claims.js). If the session is gone/hidden or its fee is
//     null, the claim is SKIPPED (regenerating to null is not a fix).
//
// It invents NO new derivation and reuses REGENERATABLE_STATUSES (draft/denied)
// from the claims handler, so it can never touch a submitted / processing /
// info_requested / appealed / paid / void claim — those are read-only from the
// session's point of view, and rewriting the coverage or amount under a claim a
// payer has already seen would be a fabrication.
//
// It only ever FILLS A MISSING value (the UPDATE coalesces), so an explicitly
// chosen insurance record or an explicitly entered billed amount is never
// overwritten. It never changes claims.status and never touches clients.status —
// making a client billable stays the clinician's "Save as default" confirm on the
// chart (see db/migrations/015 and PR #101).
//
// Hidden claims (is_hidden = true) are out of scope, matching loadClaim().
//
// -----------------------------------------------------------------------------
// NOT AUTO-APPLIED. Nothing runs this on deploy. It is an operator-run one-off,
// like the SQL files in db/migrations/ (see db/migrations/README.md).
// -----------------------------------------------------------------------------
//
// DRY RUN (the default — makes NO writes, prints what it would change):
//
//   DATABASE_URL='postgres://…' node backend/scripts/backfill-claim-derived-fields.js
//
// APPLY (writes, in ONE transaction, one audit_log row per claim changed):
//
//   DATABASE_URL='postgres://…' node backend/scripts/backfill-claim-derived-fields.js --apply
//
// RDS sits inside a VPC — run from a host with network access (bastion / tunnel),
// and pull DATABASE_URL from the secrets manager. Never paste real credentials
// into a shell history file. (DB_SSL=disable only for a local plaintext Postgres.)
//
// PRE-CHECK — how many editable claims are stranded, before the run:
//
//   select count(*) filter (where insurance_record_id is null) as missing_insurance,
//          count(*) filter (where billed_amount is null)       as missing_billed
//     from claims
//    where is_hidden = false and status in ('draft', 'denied');
//
// POST-CHECK — after --apply:
//
//   -- 1. the same query above: both counts should have dropped by exactly the
//   --    "would attach" / "would set" numbers the dry run printed. What remains
//   --    is the skipped rows (no primary insurance / no session fee), which need
//   --    a human: add coverage on the client chart, or a fee on the session.
//   -- 2. one audit row per claim changed:
//   select count(*) from audit_log where action = 'claim.backfill_derived_fields';
//   -- 3. nothing in flight was touched (must be 0):
//   select count(*) from audit_log a join claims c on c.id = a.resource_id
//    where a.action = 'claim.backfill_derived_fields'
//      and c.status not in ('draft', 'denied');
//   -- 4. idempotency: re-run the DRY RUN — it must report 0 / 0.
//
// Safe to re-run: a second --apply finds nothing left to fill and writes nothing
// (no rows to update, no audit rows).

const db = require('../lib/db');
const { primaryInsuranceForClient } = require('../lib/claims');
const { buildAuditEntry } = require('../lib/audit');
const { REGENERATABLE_STATUSES } = require('../handlers/claims');

const AUDIT_ACTION = 'claim.backfill_derived_fields';

// --- plan --------------------------------------------------------------------

// Every non-hidden claim missing at least one of the two derived fields, with the
// session fee that billed_amount would come from. The session is LEFT joined (and
// filtered like loadSession: same practice, not hidden) so a claim whose session
// is gone still shows up here and is classified as a skip rather than vanishing.
const CANDIDATE_SQL = `
  select c.id, c.practice_id, c.client_id, c.session_id, c.status,
         c.insurance_record_id, c.billed_amount, s.fee as session_fee
    from claims c
    left join sessions s
      on s.id = c.session_id and s.practice_id = c.practice_id and s.is_hidden = false
   where c.is_hidden = false
     and (c.insurance_record_id is null or c.billed_amount is null)
   order by c.created_at asc`;

// Claims with nothing missing — reported as "already set" so the summary accounts
// for the whole table, not just the rows this script would touch.
const ALREADY_SET_SQL = `
  select count(*)::int as n
    from claims
   where is_hidden = false
     and insurance_record_id is not null
     and billed_amount is not null`;

// Read-only. Returns the changes this run would make and why everything else was
// left alone. `q` is the db module or a pg client. Makes no writes.
async function buildPlan(q) {
  const candidates = await q.query(CANDIDATE_SQL, []);
  const alreadySet = await q.query(ALREADY_SET_SQL, []);

  const plan = {
    changes: [],
    skipped: {
      already_set: (alreadySet.rows[0] && alreadySet.rows[0].n) || 0,
      non_regeneratable: 0,
      no_primary_insurance: 0,
      no_session_fee: 0,
    },
  };

  // One coverage lookup per client, not per claim — a client with twelve stranded
  // claims resolves the same primary record twelve times otherwise.
  const primaryCache = new Map();
  async function primaryIdFor(practiceId, clientId) {
    const key = practiceId + ':' + clientId;
    if (!primaryCache.has(key)) {
      const rec = await primaryInsuranceForClient(q, practiceId, clientId);
      primaryCache.set(key, rec ? rec.id : null);
    }
    return primaryCache.get(key);
  }

  for (const row of candidates.rows) {
    // In-flight and terminal claims are read-only from the session's point of
    // view — the same rule regenerateClaim enforces.
    if (!REGENERATABLE_STATUSES.includes(row.status)) {
      plan.skipped.non_regeneratable += 1;
      continue;
    }

    const change = { id: row.id, practiceId: row.practice_id };

    if (row.insurance_record_id == null) {
      const insuranceRecordId = await primaryIdFor(row.practice_id, row.client_id);
      if (insuranceRecordId == null) {
        plan.skipped.no_primary_insurance += 1;
      } else {
        change.insuranceRecordId = insuranceRecordId;
      }
    }

    if (row.billed_amount == null) {
      if (row.session_fee == null) {
        plan.skipped.no_session_fee += 1;
      } else {
        change.billedAmount = row.session_fee;
      }
    }

    if ('insuranceRecordId' in change || 'billedAmount' in change) {
      plan.changes.push(change);
    }
  }

  return plan;
}

// --- apply -------------------------------------------------------------------

// coalesce() is what makes this fill-only: a value already on the row wins over
// the derived one, so a re-run (or a claim edited between the plan and the write)
// is never overwritten. The status + is_hidden predicates re-check at write time
// what buildPlan checked at read time.
const UPDATE_SQL = `
  update claims
     set insurance_record_id = coalesce(insurance_record_id, $1),
         billed_amount       = coalesce(billed_amount, $2)
   where id = $3
     and practice_id = $4
     and is_hidden = false
     and status = any($5)
     and (insurance_record_id is null or billed_amount is null)
   returning id, insurance_record_id, billed_amount`;

// The audit INSERT mirrors lib/audit.js, but runs on the transaction client so a
// rollback takes the audit rows with it (audit() writes on its own pool, which
// would leave rows claiming changes that never committed). The row itself is
// built by the shared buildAuditEntry(), so the actor/PHI rules stay in one place.
const AUDIT_SQL = `
  insert into audit_log
    (practice_id, actor_user_id, actor_type, action, resource_type, resource_id,
     ip_address, user_agent, request_id, metadata)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;

// Apply the plan on `tx` (a pg client inside a transaction). Returns the claims
// actually written — a claim whose fields were filled in between the plan and the
// write updates nothing and is not counted.
async function applyPlan(tx, plan) {
  const applied = [];

  for (const change of plan.changes) {
    const res = await tx.query(UPDATE_SQL, [
      change.insuranceRecordId != null ? change.insuranceRecordId : null,
      change.billedAmount != null ? change.billedAmount : null,
      change.id,
      change.practiceId,
      REGENERATABLE_STATUSES,
    ]);
    if (res.rowCount === 0) continue;

    const fields = [];
    if ('insuranceRecordId' in change) fields.push('insurance_record_id');
    if ('billedAmount' in change) fields.push('billed_amount');

    // No HTTP event and no user: an operator ran this out of band, so the actor
    // is the system. metadata carries field NAMES only — never a value.
    const entry = buildAuditEntry(null, { practiceId: change.practiceId, actorType: 'system' }, {
      action: AUDIT_ACTION,
      resourceType: 'claim',
      resourceId: change.id,
      metadata: { fields_changed: fields, source: 'backfill-claim-derived-fields' },
    });
    await tx.query(AUDIT_SQL, [
      entry.practice_id,
      entry.actor_user_id,
      entry.actor_type,
      entry.action,
      entry.resource_type,
      entry.resource_id,
      entry.ip_address,
      entry.user_agent,
      entry.request_id,
      entry.metadata != null ? JSON.stringify(entry.metadata) : null,
    ]);

    applied.push(change.id);
  }

  return applied;
}

// --- reporting ---------------------------------------------------------------

function countInsurance(changes) {
  return changes.filter((c) => 'insuranceRecordId' in c).length;
}

function countBilled(changes) {
  return changes.filter((c) => 'billedAmount' in c).length;
}

// Pure — the operator-facing summary. Claim ids only; no client names, no
// amounts, nothing that would put PHI on a terminal or in a shell log.
function formatSummary(plan, opts) {
  const o = opts || {};
  const applied = o.applied || null;
  const lines = [];

  const verb = applied ? 'got' : 'would get';

  lines.push(applied ? 'BACKFILL (--apply): changes committed' : 'DRY RUN: no writes were made');
  lines.push('');
  lines.push('  claims that ' + verb + ' insurance attached:    ' + countInsurance(plan.changes));
  lines.push('  claims that ' + verb + ' billed_amount set:     ' + countBilled(plan.changes));
  lines.push('  claims affected (either field):          ' + plan.changes.length);
  lines.push('');
  lines.push('  skipped — already set (nothing missing):  ' + plan.skipped.already_set);
  lines.push('  skipped — non-regeneratable status:       ' + plan.skipped.non_regeneratable);
  lines.push('  skipped — client has no primary coverage: ' + plan.skipped.no_primary_insurance);
  lines.push('  skipped — no session fee to derive from:  ' + plan.skipped.no_session_fee);
  lines.push('');

  if (plan.changes.length === 0) {
    lines.push('  affected claim ids: (none)');
  } else {
    lines.push('  affected claim ids:');
    plan.changes.forEach((c) => {
      const fields = [];
      if ('insuranceRecordId' in c) fields.push('insurance_record_id');
      if ('billedAmount' in c) fields.push('billed_amount');
      lines.push('    ' + c.id + '  ' + fields.join(', '));
    });
  }

  if (applied) {
    lines.push('');
    lines.push('  claims written: ' + applied.length);
  } else {
    lines.push('');
    lines.push('  Re-run with --apply to write these changes.');
  }

  return lines.join('\n');
}

// --- entrypoint --------------------------------------------------------------

// Dry run by default; `apply: true` writes inside a single transaction. Returns
// { plan, applied } so a caller (or a test) can assert on the outcome.
async function run(opts) {
  const apply = !!(opts && opts.apply);

  if (!apply) {
    const plan = await buildPlan(db);
    return { plan, applied: null };
  }

  // The plan is rebuilt INSIDE the transaction so the reads and the writes see
  // one consistent snapshot.
  return db.withTransaction(async (tx) => {
    const plan = await buildPlan(tx);
    const applied = await applyPlan(tx, plan);
    return { plan, applied };
  });
}

async function main(argv) {
  const apply = argv.includes('--apply');
  const { plan, applied } = await run({ apply });
  console.log(formatSummary(plan, { applied }));
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (err) => {
      // Message only — never the connection string or a row's contents.
      console.error('backfill failed:', (err && err.message) || err);
      process.exit(1);
    }
  );
}

module.exports = { buildPlan, applyPlan, run, formatSummary, AUDIT_ACTION };
