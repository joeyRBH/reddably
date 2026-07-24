'use strict';

// Shared claim-creation logic, bundled into both the claims and sessions Lambdas.
// The HTTP handler in backend/handlers/claims.js owns request parsing/validation;
// this module owns the DB-level "create a draft claim from a session" primitive so
// the auto-draft-on-completion path in the sessions handler stays byte-for-byte
// identical to POST /claims (same insurance resolution, same claim_events row).
//
// Every function takes a query runner `q` — either the `db` module (its own pool)
// or a pg client inside a transaction — so callers control the transaction scope.
// Claims carry PHI-adjacent billing data; this module never logs.

const crypto = require('crypto');

// 837P patient control number (CLM01). Payers cap this at 20 characters and Stedi
// rejects longer values (error 33); Stedi recommends staying <= 17 and using only
// alphanumeric characters (many payers mishandle special characters and truncate
// past 17 in ERAs). We generate a random 17-char uppercase alphanumeric id — a
// huge keyspace (36^17) makes collisions negligible, and it carries no PHI/pattern.
const PCN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PCN_LENGTH = 17;

function generatePatientControlNumber() {
  let out = '';
  for (let i = 0; i < PCN_LENGTH; i += 1) {
    out += PCN_ALPHABET[crypto.randomInt(PCN_ALPHABET.length)];
  }
  return out;
}

// Return the claim's stored patient control number, minting + persisting one on
// first use. Reuses the stored value on every later call (resubmission/appeal of
// the same claim must keep the same control number so 277/835 responses still
// match). The coalesce makes the write a no-op if a value already exists — safe
// under a concurrent submit — and returns whichever value won. `q` is the db
// module or a pg client inside a transaction.
async function ensurePatientControlNumber(q, practiceId, claim) {
  if (claim && claim.patient_control_number && String(claim.patient_control_number).trim() !== '') {
    return claim.patient_control_number;
  }
  const candidate = generatePatientControlNumber();
  const res = await q.query(
    `update claims
        set patient_control_number = coalesce(patient_control_number, $1)
      where id = $2 and practice_id = $3
      returning patient_control_number`,
    [candidate, claim.id, practiceId]
  );
  return res.rows[0] ? res.rows[0].patient_control_number : candidate;
}

// The client's primary non-hidden insurance record, if any. Mirrors the ordering
// POST /claims uses when auto-picking coverage for a session's client.
async function primaryInsuranceForClient(q, practiceId, clientId) {
  const res = await q.query(
    `select * from insurance_records
      where practice_id = $1 and client_id = $2 and is_hidden = false
      order by is_primary desc, created_at asc
      limit 1`,
    [practiceId, clientId]
  );
  return res.rows[0] || null;
}

// True when the session already has a non-hidden claim. The idempotency guard for
// auto-draft creation: completing a session twice must not create two claims.
async function sessionHasActiveClaim(q, practiceId, sessionId) {
  const res = await q.query(
    `select 1 from claims
      where session_id = $1 and practice_id = $2 and is_hidden = false
      limit 1`,
    [sessionId, practiceId]
  );
  return res.rowCount > 0;
}

// Persist a clearinghouse acknowledgment VERBATIM, linked to its claim. This is
// the 277CA (submission accept/reject) or a later 276/277 status payload. It is a
// passive dataset — stored, never acted on in v1. No-op when there is no payload
// to store (nothing was received). `q` is a pg client (inside a transaction) or db.
// The payload can carry PHI, so callers must never log it.
async function logClaimAcknowledgment(q, a) {
  if (a == null || a.payload == null) return;
  await q.query(
    `insert into claim_acknowledgments
       (practice_id, claim_id, source, kind, control_number, payload)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      a.practiceId,
      a.claimId,
      a.source || null,
      a.kind || 'submission',
      a.controlNumber || null,
      JSON.stringify(a.payload),
    ]
  );
}

// Insert a claim_events row. `q` is a pg client (inside a transaction) or db.
async function logClaimEvent(q, e) {
  await q.query(
    `insert into claim_events
       (practice_id, claim_id, created_by, event_type, status_from, status_to, note, payload)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      e.practiceId,
      e.claimId,
      e.createdBy || null,
      e.eventType,
      e.statusFrom || null,
      e.statusTo || null,
      e.note || null,
      e.payload != null ? JSON.stringify(e.payload) : null,
    ]
  );
}

// Insert a draft claim for a session plus its 'created' claim_events row, and
// return the claim row. Must be called inside a transaction (`q` = pg client) so
// the claim and its event commit together. Replicates POST /claims exactly.
async function insertDraftClaim(q, opts) {
  const session = opts.session;
  const ins = await q.query(
    `insert into claims
       (practice_id, session_id, client_id, clinician_id, insurance_record_id,
        claim_number, status, billed_amount)
     values ($1, $2, $3, $4, $5, $6, 'draft', $7)
     returning *`,
    [
      opts.practiceId,
      session.id,
      session.client_id,
      session.clinician_id,
      opts.insuranceRecordId != null ? opts.insuranceRecordId : null,
      opts.claimNumber != null ? opts.claimNumber : null,
      opts.billedAmount != null ? opts.billedAmount : null,
    ]
  );
  const claim = ins.rows[0];
  await logClaimEvent(q, {
    practiceId: opts.practiceId,
    claimId: claim.id,
    createdBy: opts.createdBy || null,
    eventType: 'created',
    statusTo: 'draft',
    note: opts.note || 'Claim created from session.',
  });
  return claim;
}

// Insert a REPLACEMENT (CMS frequency 7) draft claim for the claim being replaced,
// plus its 'created' claim_events row, and return the new claim row. Must run inside
// a transaction (`q` = pg client) so the claim and its event commit together.
//
// The replacement is a NEW claim on the SAME session (claims already allow multiple
// per session for resubmission/appeal), copying the original's session/client/
// clinician/insurance links and billed amount, and carrying the durable replacement
// intent: submission_frequency_code '7', the payer's original claim control number,
// and corrects_claim_id pointing at the original. It starts as a draft — the
// operator reviews and submits it through the normal submit path (which emits
// frequency 7 and runs the safety gate). The billable fields are COPIED so the
// original stays untouched (its lineage is preserved via the FK).
async function insertReplacementClaim(q, opts) {
  const original = opts.original;
  const ins = await q.query(
    `insert into claims
       (practice_id, session_id, client_id, clinician_id, insurance_record_id,
        claim_number, status, billed_amount,
        submission_frequency_code, payer_claim_control_number, corrects_claim_id)
     values ($1, $2, $3, $4, $5, $6, 'draft', $7, '7', $8, $9)
     returning *`,
    [
      opts.practiceId,
      original.session_id,
      original.client_id,
      original.clinician_id,
      original.insurance_record_id != null ? original.insurance_record_id : null,
      original.claim_number != null ? original.claim_number : null,
      original.billed_amount != null ? original.billed_amount : null,
      opts.payerClaimControlNumber,
      original.id,
    ]
  );
  const claim = ins.rows[0];
  await logClaimEvent(q, {
    practiceId: opts.practiceId,
    claimId: claim.id,
    createdBy: opts.createdBy || null,
    eventType: 'created',
    statusTo: 'draft',
    // Non-PHI note: names the lineage by short id, never the payer claim number
    // (which the operator entered and which we keep off the human-readable note).
    note: 'Replacement claim created for claim #' + String(original.id).slice(0, 8) + '.',
  });
  return claim;
}

module.exports = {
  generatePatientControlNumber,
  ensurePatientControlNumber,
  primaryInsuranceForClient,
  sessionHasActiveClaim,
  logClaimEvent,
  logClaimAcknowledgment,
  insertDraftClaim,
  insertReplacementClaim,
};
