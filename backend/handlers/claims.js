'use strict';

// Claims resource — one Lambda for the whole resource, routed internally by HTTP
// method, the presence of an {id} path parameter, and (for actions) the trailing
// path segment read from the HTTP API v2 routeKey:
//
//   POST   /claims                 → create a draft claim from a session
//   GET    /claims                 → list the practice's claims (excludes hidden);
//                                    optional ?session_id, ?client_id, ?status
//   GET    /claims/{id}            → one claim, practice-scoped
//   PATCH  /claims/{id}            → edit a DRAFT claim's billable fields
//   DELETE /claims/{id}            → soft-delete (draft/void only)
//   POST   /claims/{id}/submit     → submit via the clearinghouse adapter
//   POST   /claims/{id}/refresh    → poll the clearinghouse for status + amounts
//   POST   /claims/{id}/reconcile  → resolve an unconfirmed submission attempt
//   POST   /claims/{id}/void       → mark the claim void
//   GET    /claims/{id}/events     → the claim's status-history (claim_events)
//
// Security: practice_id is ALWAYS derived from the authenticated user, never from
// the body or token. Every query is filtered by practice_id; cross-practice / not
// found returns 404 (never 403). Claims and events carry PHI-adjacent billing data,
// so error logs stay generic. Soft-delete via is_hidden; never hard-delete.

const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');
const { parseBody } = require('../lib/util');
const { audit, sanitizeFields } = require('../lib/audit');
const { getClearinghouse } = require('../lib/clearinghouse');
const fieldCrypto = require('../lib/crypto');
const {
  primaryInsuranceForClient,
  logClaimEvent: logEvent,
  logClaimAcknowledgment: logAck,
  insertDraftClaim,
  insertReplacementClaim,
  ensurePatientControlNumber,
} = require('../lib/claims');
// Every PURE pre-submission rule lives in lib/claim_readiness.js — one
// implementation shared by this submit path and the readiness projection on
// GET /claims, so the list can never disagree with the gate. See that module's
// header for why the projection composes these rather than copying them.
const {
  missingInsuranceRecord,
  missingBillingAddressField,
  missingSubscriberField,
  missingDependentPolicyholderField,
  invalidSessionPlaceOfService,
  missingBilledAmount,
  missingSessionCptCode,
  missingDiagnosisCodes,
  excessDiagnosisCodes,
  missingPayerId,
  BLOCKER_MESSAGES,
  placeOfServiceBlockerMessage,
  ageInYears,
  evaluateSubmissionWarnings,
  REPLACEMENT_WARNING,
  isReplacementClaim,
  evaluateClaimReadiness,
} = require('../lib/claim_readiness');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CLAIM_STATUSES = [
  'draft', 'submitted', 'processing', 'info_requested',
  'denied', 'appealed', 'paid', 'void',
];

// A claim can be REPLACED (superseded by a CMS frequency-7 replacement) only after
// the payer has ACCEPTED it: it was successfully transmitted (has a control number)
// and is in an accepted lifecycle state. `denied` takes the correction/appeal path,
// not replacement; `draft`/`void` were never accepted. Frequency 7 ONLY — void
// (frequency 8) is a separate, later capability.
const REPLACEABLE_STATUSES = ['submitted', 'processing', 'info_requested', 'appealed', 'paid'];

// Submission attempted, outcome never confirmed. The submit path records the
// attempt (status 'submitted', clearinghouse set) BEFORE the network call; the
// control number is only filled in by the clearinghouse's acknowledgment. So
// 'submitted' with NO control number means exactly one thing: the claim was
// handed to the network and we never saw the answer (Lambda killed, timeout,
// connection dropped). Every claim whose submission WAS confirmed got its
// control number in the same UPDATE that set 'submitted', so the sentinel is
// unambiguous. A claim in this state must never be resubmitted blindly — the
// clearinghouse may well have accepted it (that is what happened in the
// 2026-07-26 incident) — it is resolved through POST /claims/{id}/reconcile.
function submissionOutcomeUnknown(claim) {
  return !!claim && claim.status === 'submitted' && claim.control_number == null;
}

// Failure class for clearinghouse-call logging: a coarse, PHI-free label of WHY
// the call failed (never the message text, request, or response — those can echo
// submitted PHI). This is what makes a dead submit attempt visible in CloudWatch:
// the incident Lambda timed out with zero application logs.
function clearinghouseFailureClass(err) {
  if (err && err.isRejection) return 'rejection';
  const msg = err && err.message ? String(err.message) : '';
  if (/timed out/i.test(msg)) return 'timeout';
  const m = msg.match(/HTTP (\d{3})/);
  if (m) return `http_${m[1]}`;
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket|network/i.test(msg)) return 'network';
  return 'error';
}

// claim_events.event_type enum (distinct from claim status). Used when logging.
function eventTypeForStatus(status) {
  switch (status) {
    case 'submitted': return 'submitted';
    case 'processing': return 'processing';
    case 'info_requested': return 'info_requested';
    case 'denied': return 'denied';
    case 'appealed': return 'appealed';
    case 'paid': return 'paid';
    case 'void': return 'voided';
    default: return 'note';
  }
}

// --- request helpers ---------------------------------------------------------

function httpMethod(event) {
  if (!event) return '';
  if (event.httpMethod) return event.httpMethod;
  const ctx = event.requestContext;
  return (ctx && ctx.http && ctx.http.method) || '';
}

function pathId(event) {
  return event && event.pathParameters ? event.pathParameters.id : undefined;
}

function queryParam(event, name) {
  return event && event.queryStringParameters ? event.queryStringParameters[name] : undefined;
}

// Trailing action segment for /claims/{id}/<action> routes, or null. Reads the v2
// routeKey template (stable, value-independent), falling back to the request path.
function subAction(event) {
  const rk = (event && event.requestContext && event.requestContext.routeKey) || '';
  let m = rk.match(/\/claims\/\{id\}\/([a-z]+)$/i);
  if (m) return m[1].toLowerCase();
  const path =
    (event && event.requestContext && event.requestContext.http && event.requestContext.http.path) ||
    (event && event.rawPath) || '';
  m = path.match(/\/claims\/[^/]+\/([a-z]+)\/?$/i);
  return m ? m[1].toLowerCase() : null;
}

// --- validation helpers ------------------------------------------------------

function cleanText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function isUUID(v) {
  return typeof v === 'string' && UUID_RE.test(v.trim());
}

// Optional money: absent/blank → null; otherwise finite number >= 0.
function parseMoney(v) {
  if (v == null || v === '') return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

// --- shaping -----------------------------------------------------------------

function shapeClaim(r) {
  if (!r) return null;
  return {
    id: r.id,
    practice_id: r.practice_id,
    session_id: r.session_id,
    client_id: r.client_id,
    clinician_id: r.clinician_id,
    insurance_record_id: r.insurance_record_id,
    claim_number: r.claim_number,
    control_number: r.control_number,
    patient_control_number: r.patient_control_number,
    // Replacement (CMS frequency 7) provenance — present on replacement claims,
    // null on ordinary originals. Lets the UI show a replacement badge, the
    // lineage, and the payer claim number in the submit-confirm dialog.
    submission_frequency_code: r.submission_frequency_code,
    payer_claim_control_number: r.payer_claim_control_number,
    corrects_claim_id: r.corrects_claim_id,
    // Prior authorization number (CMS-1500 Box 23 / 837P claim-level REF*G1),
    // captured at submit time and durable thereafter. Null on claims that carry none.
    prior_authorization_number: r.prior_authorization_number,
    clearinghouse: r.clearinghouse,
    status: r.status,
    billed_amount: r.billed_amount,
    allowed_amount: r.allowed_amount,
    reimbursed_amount: r.reimbursed_amount,
    patient_responsibility: r.patient_responsibility,
    denial_reason: r.denial_reason,
    submitted_at: r.submitted_at,
    is_hidden: r.is_hidden,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// List rows carry a few denormalized display fields (client name, date of
// service, payer) so the Claims table renders one row per claim without an
// N+1 fetch per claim. These are display-only; the base claim fields are
// unchanged. clients.first/last/preferred and sessions.session_date come from
// the joins in listClaims; payer prefers the insurance carrier name.
//
// ADDITIVE: the row also carries the session's billable facts (CPT, diagnosis,
// place of service) so staff can verify a draft claim from the list without
// opening it, plus `readiness` — the shared evaluator's projection (see
// lib/claim_readiness.js). readiness is computed for DRAFT claims only and is
// explicitly `null` on every other status, so the row shape is stable: a
// non-draft claim has already been sent, and a "what would submit say" answer
// about it would be meaningless.
//
// The validation INPUTS (practice address, client DOB, subscriber DOB/name,
// member id) are read by the evaluator and deliberately NOT copied onto the row.
// The list is a work queue, not a chart — it returns the verdict, never the PHI
// the verdict was derived from.
function shapeClaimRow(r) {
  const base = shapeClaim(r);
  if (!base) return null;
  const clientName =
    r.client_preferred_name ||
    [r.client_first_name, r.client_last_name].filter(Boolean).join(' ').trim() ||
    null;
  base.client_name = clientName;
  base.session_date = r.session_date || null;
  base.payer_name = r.payer_name || null;
  base.payer_id = r.payer_id || null;
  base.cpt_code = r.session_cpt_code || null;
  base.diagnosis_codes = Array.isArray(r.session_diagnosis_codes) ? r.session_diagnosis_codes : null;
  base.place_of_service = r.session_place_of_service || null;
  base.readiness = base.status === 'draft' ? evaluateClaimReadiness(readinessContext(r)) : null;
  return base;
}

// Rebuild the normalized evaluator context from one joined list row. The shapes
// must match what submit passes (buildClaimContext + loadClaim/loadInsuranceRecord),
// or the projection would answer a different question than the gate:
//
//   * insurance is the LEFT-joined record, nulled when the row is hidden —
//     loadInsuranceRecord filters is_hidden, so submit sees null there too;
//   * session and client come from the inner joins (neither is is_hidden-filtered
//     in buildClaimContext either);
//   * practice comes from the practices join, the same row buildClaimContext loads.
//
// Nothing here leaves the server: the returned object feeds the evaluator and is
// then discarded. Only { state, blockers, warnings } reaches the browser.
function readinessContext(r) {
  return {
    claim: r,
    session: {
      place_of_service: r.session_place_of_service,
      cpt_code: r.session_cpt_code,
      diagnosis_codes: r.session_diagnosis_codes,
    },
    client: {
      date_of_birth: r.client_date_of_birth,
    },
    practice: {
      address_line1: r.practice_address_line1,
      city: r.practice_city,
      state: r.practice_state,
      postal_code: r.practice_postal_code,
    },
    insurance: r.insurance_record_id != null && r.ins_is_hidden === false
      ? {
          subscriber_relationship: r.ins_subscriber_relationship,
          subscriber_name: r.ins_subscriber_name,
          subscriber_dob: r.ins_subscriber_dob,
          member_id: r.ins_member_id,
          payer_id: r.payer_id,
        }
      : null,
  };
}

// Claim-detail shaper — extends shapeClaim with a read-only `patient` block (the
// client demographics the 837 pulls at submit time) and, when the claim
// references an insurance record, an `insurance` block. ADDITIVE ONLY: every
// pre-existing top-level claim field is exactly what shapeClaim returns; this
// only appends `patient` and `insurance`. Sourced from the loadClaimDetail joins.
// Keys with no data are null. The PHI here is returned to the authenticated
// practice for its own claim — it is never logged.
function shapeClaimDetail(r) {
  if (!r) return null;
  const base = shapeClaim(r);
  base.patient = {
    first_name: r.client_first_name || null,
    last_name: r.client_last_name || null,
    preferred_name: r.client_preferred_name || null,
    date_of_birth: r.client_date_of_birth || null,
    gender: r.client_gender || null,
    address_line1: r.client_address_line1 || null,
    address_line2: r.client_address_line2 || null,
    city: r.client_city || null,
    state: r.client_state || null,
    postal_code: r.client_postal_code || null,
  };
  base.insurance = r.insurance_record_id
    ? {
        member_id: r.ins_member_id || null,
        carrier_name: r.ins_carrier_name || null,
        payer_id: r.ins_payer_id || null,
        subscriber_relationship: r.ins_subscriber_relationship || null,
        subscriber_name: r.ins_subscriber_name || null,
        subscriber_dob: r.ins_subscriber_dob || null,
      }
    : null;
  return base;
}

function shapeEvent(r) {
  if (!r) return null;
  return {
    id: r.id,
    claim_id: r.claim_id,
    event_type: r.event_type,
    status_from: r.status_from,
    status_to: r.status_to,
    note: r.note,
    created_by: r.created_by,
    created_at: r.created_at,
  };
}

// --- practice scoping + lookups ---------------------------------------------

async function loadPracticeId(userId) {
  const res = await db.query(
    `select practice_id from users where id = $1 and is_active = true limit 1`,
    [userId]
  );
  return res.rows[0] ? res.rows[0].practice_id : null;
}

async function loadSession(practiceId, sessionId) {
  const res = await db.query(
    `select * from sessions where id = $1 and practice_id = $2 and is_hidden = false limit 1`,
    [sessionId, practiceId]
  );
  return res.rows[0] || null;
}

async function loadInsuranceRecord(practiceId, recordId) {
  const res = await db.query(
    `select * from insurance_records
      where id = $1 and practice_id = $2 and is_hidden = false limit 1`,
    [recordId, practiceId]
  );
  return res.rows[0] || null;
}

async function loadClaim(practiceId, id) {
  const res = await db.query(
    `select * from claims where id = $1 and practice_id = $2 and is_hidden = false limit 1`,
    [id, practiceId]
  );
  return res.rows[0] || null;
}

// loadClaim + the patient demographics and payer identifiers the claim-detail
// view shows read-only. Kept separate from loadClaim (which submit/void/refresh
// reuse) so those paths are unaffected. clients is inner-joined (client_id is NOT
// NULL); the insurance record is optional, so left-join it. Practice-scoped and
// is_hidden-filtered exactly like loadClaim. Columns are aliased to avoid any
// collision with the claims.* columns pulled by c.*.
async function loadClaimDetail(practiceId, id) {
  const res = await db.query(
    `select c.*,
            cl.first_name     as client_first_name,
            cl.last_name      as client_last_name,
            cl.preferred_name as client_preferred_name,
            cl.date_of_birth  as client_date_of_birth,
            cl.gender         as client_gender,
            cl.address_line1  as client_address_line1,
            cl.address_line2  as client_address_line2,
            cl.city           as client_city,
            cl.state          as client_state,
            cl.postal_code    as client_postal_code,
            ir.member_id      as ins_member_id,
            ir.carrier_name   as ins_carrier_name,
            ir.payer_id       as ins_payer_id,
            ir.subscriber_relationship as ins_subscriber_relationship,
            ir.subscriber_name         as ins_subscriber_name,
            ir.subscriber_dob          as ins_subscriber_dob
       from claims c
       join clients cl on cl.id = c.client_id
       left join insurance_records ir on ir.id = c.insurance_record_id
      where c.id = $1 and c.practice_id = $2 and c.is_hidden = false
      limit 1`,
    [id, practiceId]
  );
  return res.rows[0] || null;
}

// Assemble the normalized context an adapter needs (no DB access in adapters).
async function buildClaimContext(practiceId, claim) {
  const [sessionRes, clientRes, clinicianRes, practiceRes, profileRes] = await Promise.all([
    db.query(`select * from sessions where id = $1 and practice_id = $2 limit 1`, [claim.session_id, practiceId]),
    db.query(`select * from clients where id = $1 and practice_id = $2 limit 1`, [claim.client_id, practiceId]),
    db.query(`select * from users where id = $1 and practice_id = $2 limit 1`, [claim.clinician_id, practiceId]),
    db.query(`select * from practices where id = $1 limit 1`, [practiceId]),
    db.query(
      `select * from provider_billing_profiles where practice_id = $1 and provider_user_id = $2 limit 1`,
      [practiceId, claim.clinician_id]
    ),
  ]);
  let insurance = null;
  if (claim.insurance_record_id) {
    insurance = await loadInsuranceRecord(practiceId, claim.insurance_record_id);
  }

  // The rendering clinician's billing profile decides how the 837P billing- and
  // rendering-provider loops are built (person vs organization). Decrypt the
  // person billing TIN here so the adapter stays a pure, DB-/key-free function of
  // ctx (it reads billingProfile.billing_tin as plaintext digits). A decrypt
  // failure leaves billing_tin undefined; the adapter falls back accordingly.
  let billingProfile = profileRes.rows[0] || null;
  if (billingProfile && billingProfile.billing_tin_ciphertext) {
    try {
      billingProfile = { ...billingProfile, billing_tin: fieldCrypto.decrypt(billingProfile.billing_tin_ciphertext) };
    } catch (_) {
      billingProfile = { ...billingProfile, billing_tin: null };
    }
  }

  return {
    claim,
    session: sessionRes.rows[0] || null,
    client: clientRes.rows[0] || null,
    clinician: clinicianRes.rows[0] || null,
    practice: practiceRes.rows[0] || null,
    billingProfile,
    insurance,
    payer_id: null, // not modeled yet; the Claim.MD adapter flags this
  };
}

// --- handlers ----------------------------------------------------------------

async function createClaim(practiceId, userId, body, event, authCtx) {
  const sessionId = cleanText(body.session_id);
  if (!sessionId) {
    return json(400, { error: 'Missing required fields: session_id' }, event);
  }
  if (!isUUID(sessionId)) {
    return json(400, { error: 'Invalid session_id.' }, event);
  }
  const session = await loadSession(practiceId, sessionId);
  if (!session) {
    return json(400, { error: 'session_id is not a session in this practice.' }, event);
  }

  // Optional explicit insurance record, else auto-pick the client's primary.
  let insuranceRecordId = null;
  if ('insurance_record_id' in body && body.insurance_record_id != null && body.insurance_record_id !== '') {
    const rid = cleanText(body.insurance_record_id);
    if (!isUUID(rid)) {
      return json(400, { error: 'Invalid insurance_record_id.' }, event);
    }
    const rec = await loadInsuranceRecord(practiceId, rid);
    if (!rec || rec.client_id !== session.client_id) {
      return json(400, { error: 'insurance_record_id is not an insurance record for this client.' }, event);
    }
    insuranceRecordId = rec.id;
  } else {
    const primary = await primaryInsuranceForClient(db, practiceId, session.client_id);
    insuranceRecordId = primary ? primary.id : null;
  }

  const billed = parseMoney(body.billed_amount);
  if (!billed.ok) {
    return json(400, { error: 'Invalid billed_amount. Expected a number >= 0.' }, event);
  }
  const billedAmount = billed.value != null ? billed.value : session.fee;

  const result = await db.withTransaction(async (client) => {
    return insertDraftClaim(client, {
      practiceId,
      session,
      insuranceRecordId,
      claimNumber: cleanText(body.claim_number),
      billedAmount,
      createdBy: userId,
    });
  });

  await audit(event, authCtx, {
    action: 'claim.create',
    resourceType: 'claim',
    resourceId: result.id,
  });
  return json(201, { claim: shapeClaim(result) }, event);
}

async function listClaims(practiceId, event, authCtx) {
  const params = [practiceId];
  // Columns are qualified (c./s./ir.) because the list joins clients, sessions,
  // and the optional insurance record for the table's display fields.
  let where = `c.practice_id = $1 and c.is_hidden = false`;

  const sessionId = queryParam(event, 'session_id');
  if (sessionId != null && sessionId !== '') {
    if (!isUUID(sessionId)) return json(400, { error: 'Invalid session_id.' }, event);
    params.push(sessionId);
    where += ` and c.session_id = $${params.length}`;
  }

  const clientId = queryParam(event, 'client_id');
  if (clientId != null && clientId !== '') {
    if (!isUUID(clientId)) return json(400, { error: 'Invalid client_id.' }, event);
    params.push(clientId);
    where += ` and c.client_id = $${params.length}`;
  }

  const status = queryParam(event, 'status');
  if (status != null && status !== '') {
    if (!CLAIM_STATUSES.includes(status)) {
      return json(400, { error: `Invalid status. Expected one of: ${CLAIM_STATUSES.join(', ')}.` }, event);
    }
    params.push(status);
    where += ` and c.status = $${params.length}`;
  }

  // client_id / session_id are NOT NULL on claims, so inner-join those; the
  // insurance record is optional, so left-join it for the payer columns.
  //
  // ONE set-based query, never a per-claim loop: the readiness projection needs
  // practice, client, insurance and session fields, so they are selected here
  // alongside the display columns. practices is inner-joined on the claim's own
  // practice_id (always present, one row) — it costs one join, not one query per
  // claim. The insurance join is unchanged (still a plain left join, still
  // unfiltered) so payer_name / payer_id keep their exact current values; the
  // evaluator reads ins_is_hidden instead and treats a hidden record as absent,
  // which is what submit's loadInsuranceRecord does.
  const res = await db.query(
    `select c.*,
            cl.first_name     as client_first_name,
            cl.last_name      as client_last_name,
            cl.preferred_name as client_preferred_name,
            cl.date_of_birth  as client_date_of_birth,
            s.session_date    as session_date,
            s.cpt_code        as session_cpt_code,
            s.diagnosis_codes as session_diagnosis_codes,
            s.place_of_service as session_place_of_service,
            ir.carrier_name   as payer_name,
            ir.payer_id       as payer_id,
            ir.is_hidden      as ins_is_hidden,
            ir.member_id      as ins_member_id,
            ir.subscriber_relationship as ins_subscriber_relationship,
            ir.subscriber_name         as ins_subscriber_name,
            ir.subscriber_dob          as ins_subscriber_dob,
            pr.address_line1  as practice_address_line1,
            pr.city           as practice_city,
            pr.state          as practice_state,
            pr.postal_code    as practice_postal_code
       from claims c
       join clients cl  on cl.id = c.client_id
       join sessions s  on s.id = c.session_id
       join practices pr on pr.id = c.practice_id
       left join insurance_records ir on ir.id = c.insurance_record_id
      where ${where}
      order by c.created_at desc`,
    params
  );
  await audit(event, authCtx, {
    action: 'claim.list',
    resourceType: 'claim',
    metadata: { count: res.rowCount },
  });
  return json(200, { claims: res.rows.map(shapeClaimRow) }, event);
}

async function getClaim(practiceId, id, event, authCtx) {
  if (!isUUID(id)) return json(404, { error: 'Not found' }, event);
  const row = await loadClaimDetail(practiceId, id);
  if (!row) return json(404, { error: 'Not found' }, event);
  await audit(event, authCtx, {
    action: 'claim.view',
    resourceType: 'claim',
    resourceId: id,
  });
  return json(200, { claim: shapeClaimDetail(row) }, event);
}

async function updateClaim(practiceId, id, body, event, authCtx) {
  if (!isUUID(id)) return json(404, { error: 'Not found' }, event);
  const claim = await loadClaim(practiceId, id);
  if (!claim) return json(404, { error: 'Not found' }, event);
  if (claim.status !== 'draft') {
    return json(409, { error: 'Only draft claims can be edited.' }, event);
  }

  // Immutable links — a claim stays bound to its session/client/clinician.
  for (const k of ['session_id', 'client_id', 'clinician_id', 'status', 'control_number']) {
    if (k in body) return json(400, { error: `${k} cannot be changed.` }, event);
  }

  const sets = [];
  const params = [];
  const changes = {};
  const add = (col, val) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
    changes[col] = val;
  };

  if ('claim_number' in body) add('claim_number', cleanText(body.claim_number));

  if ('billed_amount' in body) {
    const billed = parseMoney(body.billed_amount);
    if (!billed.ok) return json(400, { error: 'Invalid billed_amount. Expected a number >= 0.' }, event);
    add('billed_amount', billed.value);
  }

  if ('insurance_record_id' in body) {
    const rid = cleanText(body.insurance_record_id);
    if (rid == null) {
      add('insurance_record_id', null);
    } else {
      if (!isUUID(rid)) return json(400, { error: 'Invalid insurance_record_id.' }, event);
      const rec = await loadInsuranceRecord(practiceId, rid);
      if (!rec || rec.client_id !== claim.client_id) {
        return json(400, { error: 'insurance_record_id is not an insurance record for this client.' }, event);
      }
      add('insurance_record_id', rec.id);
    }
  }

  if (sets.length === 0) {
    return json(400, { error: 'No updatable fields provided.' }, event);
  }

  params.push(id);
  const idParam = `$${params.length}`;
  params.push(practiceId);
  const practiceParam = `$${params.length}`;

  const res = await db.query(
    `update claims set ${sets.join(', ')}
      where id = ${idParam} and practice_id = ${practiceParam} and is_hidden = false and status = 'draft'
      returning *`,
    params
  );
  if (res.rowCount === 0) return json(404, { error: 'Not found' }, event);
  await audit(event, authCtx, {
    action: 'claim.update',
    resourceType: 'claim',
    resourceId: id,
    metadata: { fields_changed: sanitizeFields(claim, changes) },
  });
  return json(200, { claim: shapeClaim(res.rows[0]) }, event);
}

async function deleteClaim(practiceId, id, event, authCtx) {
  if (!isUUID(id)) return json(404, { error: 'Not found' }, event);
  const claim = await loadClaim(practiceId, id);
  if (!claim) return json(404, { error: 'Not found' }, event);
  if (claim.status !== 'draft' && claim.status !== 'void') {
    return json(409, { error: 'Only draft or void claims can be deleted; void the claim first.' }, event);
  }
  const res = await db.query(
    `update claims set is_hidden = true
      where id = $1 and practice_id = $2 and is_hidden = false
      returning id`,
    [id, practiceId]
  );
  if (res.rowCount === 0) return json(404, { error: 'Not found' }, event);
  await audit(event, authCtx, {
    action: 'claim.delete',
    resourceType: 'claim',
    resourceId: id,
  });
  return json(200, { deleted: true, id: res.rows[0].id }, event);
}

async function submitClaim(practiceId, userId, id, body, event, authCtx) {
  if (!isUUID(id)) return json(404, { error: 'Not found' }, event);
  const claim = await loadClaim(practiceId, id);
  if (!claim) return json(404, { error: 'Not found' }, event);
  // Unsafe-retry guard: a prior attempt on this claim never confirmed its
  // outcome, so the clearinghouse may already hold it. Resubmitting now could
  // file a duplicate — refuse with the remedy, never a generic status error.
  if (submissionOutcomeUnknown(claim)) {
    return json(409, {
      error: 'A previous submission attempt for this claim was never confirmed — the clearinghouse may already have it. Reconcile the claim with the clearinghouse first; resubmitting now could file a duplicate.',
      outcome: 'unknown',
    }, event);
  }
  if (claim.status !== 'draft') {
    return json(409, { error: 'Only draft claims can be submitted.' }, event);
  }
  // Coverage to bill. Stays HERE — before the patient control number is minted
  // and before any context is built — so a claim with no insurance is never
  // mutated by a submit attempt. 400 (not 422) is the long-standing answer.
  if (missingInsuranceRecord(claim)) {
    return json(400, { error: BLOCKER_MESSAGES.missing_insurance_record }, event);
  }

  // Mint (or reuse) the <=20-char patient control number BEFORE building the
  // payload. Persisting it up front keeps it stable across resubmissions and lets
  // 277/835 responses match back to this claim. Reused as-is if already set.
  claim.patient_control_number = await ensurePatientControlNumber(db, practiceId, claim);

  // Prior authorization number (CMS-1500 Box 23 / 837P claim-level REF*G1) is
  // captured in the submit flow and copied into the immutable submission context
  // (the durable claims row written below), mirroring how the replacement
  // frequency is captured. A value on THIS request wins; otherwise the value the
  // claim already carries is reused, so it stays stable across resubmissions.
  // Set on `claim` BEFORE buildClaimContext so the builder emits it this submission
  // (buildClaimContext passes `claim` straight through into ctx). Absent → null,
  // and the builder omits the field entirely.
  const priorAuthInput = cleanText(body && body.prior_authorization_number);
  claim.prior_authorization_number = priorAuthInput || cleanText(claim.prior_authorization_number) || null;

  const ctx = await buildClaimContext(practiceId, claim);

  // Block submission before it reaches the clearinghouse if the practice has no
  // billing address — otherwise Stedi 400s and the user sees an opaque 502.
  if (missingBillingAddressField(ctx.practice)) {
    return json(422, { error: BLOCKER_MESSAGES.practice_billing_address }, event);
  }

  // The subscriber's date of birth is required by the 837P. A client created by
  // staff may not have one yet (the client supplies it in the SMS intake), so
  // catch it here as a clean 422 rather than a downstream 500/502.
  if (missingSubscriberField(ctx.client)) {
    return json(422, { error: BLOCKER_MESSAGES.client_date_of_birth }, event);
  }

  // Dependent claims put the policyholder in the 837P subscriber loop, which
  // requires their name and date of birth. Block early with a clean 422 rather
  // than letting the incomplete record reach Stedi as an opaque error.
  if (missingDependentPolicyholderField(ctx.insurance)) {
    return json(422, { error: BLOCKER_MESSAGES.dependent_policyholder }, event);
  }

  // Place of service must be a valid two-character CMS code before the claim can
  // go out — a free-text value ("office") is rejected by the payer at the front
  // door (837P 2300/CLM-05-01). HARD block, not a soft warning: no confirmation
  // makes an invalid code transmittable. An EMPTY value stays submittable — the
  // adapter defaults it to 11 (office).
  const sessionPlaceOfService = invalidSessionPlaceOfService(ctx.session);
  if (sessionPlaceOfService != null) {
    return json(422, { error: placeOfServiceBlockerMessage() }, event);
  }

  // Billable CONTENT — the charge, the procedure code, the diagnoses and the
  // payer that routes the claim. Everything above this point is setup and
  // demographics; without these the claim either bills nothing or cannot be
  // addressed, and the clearinghouse rejects it. Two of them are worse than a
  // rejection: a missing payer id and an over-limit diagnosis list make the
  // adapter throw while BUILDING the body, which happens after the claim has
  // already moved to 'submitted' below — leaving a claim that was never
  // transmitted stranded in a retry-blocked state. Blocking here keeps it a draft,
  // with a message that names the fix. The adapter's own throws stay in place as
  // a backstop for direct callers; normal flow never reaches them.
  if (missingBilledAmount(claim)) {
    return json(422, { error: BLOCKER_MESSAGES.claim_billed_amount }, event);
  }
  if (missingSessionCptCode(ctx.session)) {
    return json(422, { error: BLOCKER_MESSAGES.session_cpt_code }, event);
  }
  if (missingDiagnosisCodes(ctx.session)) {
    return json(422, { error: BLOCKER_MESSAGES.claim_diagnosis_codes }, event);
  }
  if (excessDiagnosisCodes(ctx.session) != null) {
    return json(422, { error: BLOCKER_MESSAGES.claim_diagnosis_limit }, event);
  }
  if (missingPayerId(ctx.insurance)) {
    return json(422, { error: BLOCKER_MESSAGES.insurance_payer_id }, event);
  }

  // Replacement (CMS frequency 7) safety gate. A replacement asks the payer to
  // REPLACE a claim it already accepted; getting it wrong files another duplicate.
  // Every failure below is a HARD REJECT, never a silent downgrade to a new
  // original ('1') — a downgrade would create exactly the duplicate this feature
  // exists to prevent. Runs before the soft-warning flow and regardless of
  // `confirmed`. ("Not in an eligible lifecycle state" and "currently submitting"
  // are already enforced above: the status!=='draft' check 409s, and the atomic
  // status='draft'-gated UPDATE below is the in-flight guard for concurrent submits.)
  if (isReplacementClaim(claim)) {
    // (1) Must carry the payer's ORIGINAL claim number. Without it the builder
    //     cannot form REF*F8 and the claim would go out as a duplicate original.
    if (!cleanText(claim.payer_claim_control_number)) {
      return json(422, {
        error: "This replacement is missing the payer's original claim number, so it cannot be filed. Re-create the replacement with that number.",
      }, event);
    }
    // (2) Must reference an original that exists and was successfully transmitted
    //     and accepted — otherwise there is nothing for the payer to replace.
    if (!claim.corrects_claim_id) {
      return json(422, { error: 'This replacement does not reference the claim it replaces.' }, event);
    }
    const original = await loadClaim(practiceId, claim.corrects_claim_id);
    if (!original || !cleanText(original.control_number) || !REPLACEABLE_STATUSES.includes(original.status)) {
      return json(422, {
        error: 'The claim being replaced was never accepted by the payer, so it cannot be replaced.',
      }, event);
    }
    // (3) Never file two replacements of the same original. If another replacement
    //     of this original has already been submitted (has a control number), a
    //     second would create yet another duplicate — refuse.
    const priorReplacement = await db.query(
      `select 1 from claims
        where practice_id = $1 and corrects_claim_id = $2 and id <> $3
          and is_hidden = false and control_number is not null
        limit 1`,
      [practiceId, claim.corrects_claim_id, id]
    );
    if (priorReplacement.rowCount > 0) {
      return json(409, { error: 'A replacement for this claim has already been submitted.' }, event);
    }
  }

  // Soft pre-submission sanity check. Warnings never hard-block: without an
  // explicit confirmed:true the submit is held and the warnings are returned so
  // the UI can list them and offer "Submit anyway". Audit records CODES only —
  // the messages may embed non-PHI context but are never written to the log.
  const confirmed = body && body.confirmed === true;
  const warnings = evaluateSubmissionWarnings(ctx);
  // A replacement ALWAYS requires an explicit confirmation before it is sent: the
  // operator must acknowledge it replaces a previously accepted claim (and see the
  // payer claim number) rather than filing a new original. Prepended as a warning
  // so it flows through the existing confirmation gate; only its CODE is audited,
  // never the payer claim number it carries for the dialog.
  if (isReplacementClaim(claim)) {
    warnings.unshift({
      code: REPLACEMENT_WARNING.code,
      message: REPLACEMENT_WARNING.message,
      payer_claim_control_number: cleanText(claim.payer_claim_control_number),
    });
  }
  if (warnings.length && !confirmed) {
    await audit(event, authCtx, {
      action: 'claim.submit_warned',
      resourceType: 'claim',
      resourceId: id,
      metadata: { warning_codes: warnings.map((w) => w.code) },
    });
    return json(200, { requires_confirmation: true, warnings }, event);
  }

  const adapter = getClearinghouse();

  // Test-mode submission (837P usageIndicator 'T'): Stedi processes the claim and
  // returns a 277CA but never forwards it to the payer. Reaching it takes TWO
  // independent gates, because both mistakes are expensive — a stray 'T' in
  // production is a claim that is never reimbursed and never rejected, and a
  // missing 'T' during testing files synthetic patient data as a real claim:
  //
  //   1. the deployment must opt in (STEDI_ALLOW_TEST_SUBMISSIONS — operator-set
  //      Lambda config, absent in production), and
  //   2. a practice admin must ask for it explicitly on this request.
  //
  // The env gate is the real guard; the role check just keeps a clinician from
  // flipping it. Nothing here is inferred — a request that asks for a test
  // submission the environment forbids is REFUSED, never quietly downgraded to a
  // production claim.
  if (body && body.test_submission === true) {
    if (authCtx && authCtx.role !== 'practice_admin') {
      return json(403, { error: 'Only a practice admin can send a test submission.' }, event);
    }
    if (typeof adapter.testSubmissionsAllowed !== 'function' || !adapter.testSubmissionsAllowed()) {
      return json(403, {
        error: 'Test submissions are not enabled in this environment.',
      }, event);
    }
    ctx.testSubmission = true;
    await audit(event, authCtx, {
      action: 'claim.submit_test_mode',
      resourceType: 'claim',
      resourceId: id,
    });
  }

  // The frequency actually submitted, persisted durably on the claim (the
  // submission record) so we can always explain what was sent — '7' for a
  // replacement (already stored, reaffirmed here), '1' for an ordinary original.
  const submittedFrequency = isReplacementClaim(claim) ? '7' : '1';

  // Record the submission attempt BEFORE the network call. The claim moves to
  // 'submitted' with control_number NULL (= outcome unknown, see
  // submissionOutcomeUnknown) carrying everything about what is being sent —
  // clearinghouse, frequency, prior auth; the patient control number was already
  // persisted above. If the Lambda dies mid-call, times out, or the connection
  // drops, the claim is left in a state that BLOCKS retry and demands
  // reconciliation — never a failed-looking state that invites a duplicate. This
  // is the fix for the 2026-07-26 incident, where a submit that timed out had
  // actually been ACCEPTED by the clearinghouse while the claim still read as
  // unsubmitted. The status='draft' gate doubles as the concurrent-submit guard.
  const pending = await db.withTransaction(async (client) => {
    const res = await client.query(
      `update claims
          set status = 'submitted',
              submitted_at = now(),
              control_number = null,
              clearinghouse = $1,
              submission_frequency_code = $2,
              prior_authorization_number = $3
        where id = $4 and practice_id = $5 and is_hidden = false and status = 'draft'
        returning *`,
      [
        adapter.name,
        submittedFrequency,
        cleanText(claim.prior_authorization_number),
        id,
        practiceId,
      ]
    );
    if (res.rowCount === 0) return null;
    await logEvent(client, {
      practiceId,
      claimId: id,
      createdBy: userId,
      eventType: 'note',
      statusFrom: 'draft',
      statusTo: 'submitted',
      note: 'Submission attempt recorded; transmitting to clearinghouse.',
    });
    return res.rows[0];
  });
  if (!pending) return json(409, { error: 'Claim is no longer in a submittable state.' }, event);

  // Breadcrumb BEFORE the call: even if the Lambda is hard-killed mid-request
  // (the incident produced zero application logs), CloudWatch shows which claim
  // was in flight. Ids only — never PHI, never the 837P payload.
  console.log(`claims submit: transmitting claim ${id} via ${adapter.name}`);

  let result;
  try {
    result = await adapter.submitClaim(ctx);
  } catch (err) {
    // Ids + failure class only — the message/response can echo submitted PHI.
    console.error(`claims submit: clearinghouse call failed (claim ${id}, class ${clearinghouseFailureClass(err)})`);

    // A clearinghouse *rejection* (e.g. Stedi error 33 — invalid control number)
    // is a CONFIRMED outcome: the clearinghouse received the claim and refused
    // it, so nothing was filed. Return the claim to draft (so it can be fixed
    // and resubmitted, reusing the same patient control number) and surface the
    // reason as a 422 the way VOB AAA rejections are surfaced. The description
    // is not logged (it may echo submitted PHI).
    if (err && err.isRejection) {
      await db.withTransaction(async (client) => {
        const res = await client.query(
          `update claims set status = 'draft', submitted_at = null
            where id = $1 and practice_id = $2 and is_hidden = false
              and status = 'submitted' and control_number is null
            returning id`,
          [id, practiceId]
        );
        if (res.rowCount > 0) {
          await logEvent(client, {
            practiceId,
            claimId: id,
            createdBy: userId,
            eventType: 'note',
            statusFrom: 'submitted',
            statusTo: 'draft',
            note: 'Clearinghouse rejected the submission; claim returned to draft.',
          });
        }
      });
      return json(422, { error: err.message, rejection: err.rejection || null }, event);
    }

    // Anything else — timeout, network failure, an opaque 5xx — is an UNKNOWN
    // outcome: the claim may or may not have been received (in the incident it
    // WAS accepted). Leave the pending record exactly as written above so retry
    // stays blocked, and tell the user to reconcile, not retry. The event write
    // is best-effort: if it fails the claim is already in the safe state.
    try {
      await db.withTransaction(async (client) => {
        await logEvent(client, {
          practiceId,
          claimId: id,
          createdBy: userId,
          eventType: 'note',
          note: `Submission outcome unknown (${clearinghouseFailureClass(err)}). Do not resubmit — reconcile with the clearinghouse first.`,
        });
      });
    } catch (_) { /* claim already safely blocked; the 502 below still stands */ }
    return json(502, {
      error: 'The clearinghouse did not confirm this submission — the claim may still have been received. Do not resubmit; reconcile the claim to adopt its real status.',
      outcome: 'unknown',
    }, event);
  }

  // Confirmed accepted: fill in the acknowledgment. The WHERE clause targets
  // exactly the pending record written above (submitted + no control number).
  const updated = await db.withTransaction(async (client) => {
    const res = await client.query(
      `update claims
          set control_number = $1,
              claim_number = coalesce(claim_number, $2),
              clearinghouse_payload = $3
        where id = $4 and practice_id = $5 and is_hidden = false
          and status = 'submitted' and control_number is null
        returning *`,
      [
        cleanText(result.control_number),
        cleanText(result.claim_number),
        result.raw != null ? JSON.stringify(result.raw) : null,
        id,
        practiceId,
      ]
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    await logEvent(client, {
      practiceId,
      claimId: row.id,
      createdBy: userId,
      eventType: 'submitted',
      statusFrom: 'draft',
      statusTo: 'submitted',
      // Human-readable snapshot of what was filed on the submission record. Names
      // the replaced claim by short id only — never the payer claim number (PHI-
      // adjacent, and it lives structured in payer_claim_control_number already).
      note: submittedFrequency === '7'
        ? 'Submitted electronically as a replacement (frequency 7) of claim #' +
          String(claim.corrects_claim_id || '').slice(0, 8) + '.'
        : 'Submitted electronically.',
      payload: result.raw,
    });
    // Persist the submission acknowledgment (277CA) verbatim — passive dataset,
    // stored, never acted on. No-op when the adapter returned no raw payload.
    await logAck(client, {
      practiceId,
      claimId: row.id,
      source: adapter.name,
      kind: 'submission',
      controlNumber: result.control_number,
      payload: result.raw,
    });
    return row;
  });

  // The pending record vanished mid-call (e.g. voided concurrently). The
  // clearinghouse HAS the claim but our row no longer matches — reconciliation
  // is the only safe path from here, so say so rather than a generic error.
  if (!updated) {
    return json(409, {
      error: 'Claim state changed while the submission was in flight. Reconcile the claim with the clearinghouse before taking further action.',
    }, event);
  }
  await audit(event, authCtx, {
    action: 'claim.submit',
    resourceType: 'claim',
    resourceId: id,
    // When the caller confirmed past sanity warnings, record which ones by CODE
    // (never the messages) so the override is auditable without leaking PHI.
    metadata: warnings.length
      ? { clearinghouse: adapter.name, status: updated.status, override_warning_codes: warnings.map((w) => w.code) }
      : { clearinghouse: adapter.name, status: updated.status },
  });
  return json(200, { claim: shapeClaim(updated) }, event);
}

// POST /claims/{id}/reconcile — resolve a claim whose submission attempt never
// confirmed (status 'submitted', no control number; see submissionOutcomeUnknown).
// Three modes, all practice-scoped and all gated on that exact state:
//
//   (default, no body)             Look the claim up at the clearinghouse by its
//                                  patient control number and ADOPT the real
//                                  status. A no-match does NOT touch the claim —
//                                  a payer that hasn't indexed a minutes-old
//                                  claim also answers "not found", and reverting
//                                  on that would re-enable the duplicate.
//   { resolution: 'received',      Operator checked the clearinghouse dashboard
//     control_number }             and confirmed the claim WAS accepted: record
//                                  its control number, claim stays 'submitted'.
//   { resolution: 'not_received' } Operator confirmed it never arrived: return
//                                  the claim to draft. The patient control
//                                  number is retained, so a resubmission reuses
//                                  it and the clearinghouse can recognize a
//                                  duplicate even if the operator was wrong.
async function reconcileClaim(practiceId, userId, id, body, event, authCtx) {
  if (!isUUID(id)) return json(404, { error: 'Not found' }, event);
  const claim = await loadClaim(practiceId, id);
  if (!claim) return json(404, { error: 'Not found' }, event);
  if (!submissionOutcomeUnknown(claim)) {
    return json(409, { error: 'Only a claim with an unconfirmed submission attempt can be reconciled.' }, event);
  }

  const resolution = cleanText(body && body.resolution);
  if (resolution != null && resolution !== 'received' && resolution !== 'not_received') {
    return json(400, { error: "Invalid resolution. Expected 'received' or 'not_received'." }, event);
  }

  if (resolution === 'not_received') {
    const updated = await db.withTransaction(async (client) => {
      const res = await client.query(
        `update claims set status = 'draft', submitted_at = null
          where id = $1 and practice_id = $2 and is_hidden = false
            and status = 'submitted' and control_number is null
          returning *`,
        [id, practiceId]
      );
      if (res.rowCount === 0) return null;
      await logEvent(client, {
        practiceId,
        claimId: id,
        createdBy: userId,
        eventType: 'note',
        statusFrom: 'submitted',
        statusTo: 'draft',
        note: 'Operator confirmed the clearinghouse never received this claim; returned to draft. The patient control number is retained for resubmission.',
      });
      return res.rows[0];
    });
    if (!updated) return json(409, { error: 'Claim is no longer awaiting reconciliation.' }, event);
    await audit(event, authCtx, {
      action: 'claim.reconcile',
      resourceType: 'claim',
      resourceId: id,
      metadata: { outcome: 'not_received' },
    });
    return json(200, {
      claim: shapeClaim(updated),
      outcome: 'reverted',
      message: 'Claim returned to draft. Resubmitting reuses the same patient control number.',
    }, event);
  }

  if (resolution === 'received') {
    // The clearinghouse-assigned control number, read off its dashboard. Required:
    // without it the claim would stay in the unknown state this endpoint resolves.
    const controlNumber = cleanText(body && body.control_number);
    if (!controlNumber) {
      return json(400, { error: "control_number (from the clearinghouse) is required when resolution is 'received'." }, event);
    }
    const updated = await db.withTransaction(async (client) => {
      const res = await client.query(
        `update claims set control_number = $1
          where id = $2 and practice_id = $3 and is_hidden = false
            and status = 'submitted' and control_number is null
          returning *`,
        [controlNumber, id, practiceId]
      );
      if (res.rowCount === 0) return null;
      await logEvent(client, {
        practiceId,
        claimId: id,
        createdBy: userId,
        eventType: 'note',
        note: 'Operator confirmed the clearinghouse received this claim; its control number was recorded.',
      });
      return res.rows[0];
    });
    if (!updated) return json(409, { error: 'Claim is no longer awaiting reconciliation.' }, event);
    await audit(event, authCtx, {
      action: 'claim.reconcile',
      resourceType: 'claim',
      resourceId: id,
      metadata: { outcome: 'received' },
    });
    return json(200, {
      claim: shapeClaim(updated),
      outcome: 'adopted',
      message: 'Submission confirmed; the claim is now tracked as submitted.',
    }, event);
  }

  // Default: ask the clearinghouse. The lookup matches on the patient control
  // number the pending attempt persisted before transmitting.
  const pcn = cleanText(claim.patient_control_number);
  if (!pcn) {
    return json(409, { error: 'Claim has no patient control number to reconcile by.' }, event);
  }
  const adapter = getClearinghouse();
  if (typeof adapter.reconcileSubmission !== 'function') {
    return json(409, {
      error: "The configured clearinghouse does not support automatic reconciliation. Check its dashboard, then reconcile with resolution 'received' or 'not_received'.",
    }, event);
  }

  const ctx = await buildClaimContext(practiceId, claim);
  let result;
  try {
    result = await adapter.reconcileSubmission({ ctx, patientControlNumber: pcn });
  } catch (err) {
    // Ids + failure class only — never PHI, never the request/response payload.
    console.error(`claims reconcile: clearinghouse call failed (claim ${id}, class ${clearinghouseFailureClass(err)})`);
    return json(502, { error: 'Clearinghouse reconciliation lookup failed.' }, event);
  }

  if (!result || result.found !== true) {
    // No match is NOT evidence the claim never arrived — leave the claim blocked.
    await audit(event, authCtx, {
      action: 'claim.reconcile',
      resourceType: 'claim',
      resourceId: id,
      metadata: { outcome: 'no_match' },
    });
    return json(200, {
      claim: shapeClaim(claim),
      outcome: 'no_match',
      message: "The clearinghouse returned no match for this claim yet. If its dashboard confirms the claim was never received, reconcile again with resolution 'not_received'.",
    }, event);
  }

  const newStatus = result.status;
  if (!CLAIM_STATUSES.includes(newStatus)) {
    console.error('claims reconcile: adapter returned unknown status');
    return json(502, { error: 'Clearinghouse returned an unrecognized status.' }, event);
  }

  const updated = await db.withTransaction(async (client) => {
    const res = await client.query(
      `update claims
          set status = $1,
              control_number = coalesce($2, control_number)
        where id = $3 and practice_id = $4 and is_hidden = false
          and status = 'submitted' and control_number is null
        returning *`,
      [newStatus, cleanText(result.control_number), id, practiceId]
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    await logEvent(client, {
      practiceId,
      claimId: row.id,
      createdBy: userId,
      eventType: eventTypeForStatus(newStatus),
      statusFrom: 'submitted',
      statusTo: newStatus,
      note: 'Reconciled with the clearinghouse; adopted its status for the earlier unconfirmed submission.',
      payload: result.raw,
    });
    // Store the reconciliation payload verbatim like any other status response —
    // passive dataset, stored, never acted on. No-op without a raw payload.
    await logAck(client, {
      practiceId,
      claimId: row.id,
      source: adapter.name,
      kind: 'status',
      controlNumber: pcn,
      payload: result.raw,
    });
    return row;
  });
  if (!updated) return json(409, { error: 'Claim is no longer awaiting reconciliation.' }, event);
  await audit(event, authCtx, {
    action: 'claim.reconcile',
    resourceType: 'claim',
    resourceId: id,
    metadata: { outcome: 'adopted', status: updated.status },
  });
  return json(200, {
    claim: shapeClaim(updated),
    outcome: 'adopted',
    message: 'Clearinghouse status adopted.',
  }, event);
}

async function refreshClaim(practiceId, userId, id, event, authCtx) {
  if (!isUUID(id)) return json(404, { error: 'Not found' }, event);
  const claim = await loadClaim(practiceId, id);
  if (!claim) return json(404, { error: 'Not found' }, event);
  if (!claim.control_number) {
    if (submissionOutcomeUnknown(claim)) {
      return json(409, {
        error: 'This claim has an unconfirmed submission attempt. Reconcile it with the clearinghouse first.',
        outcome: 'unknown',
      }, event);
    }
    return json(409, { error: 'Claim has not been submitted to a clearinghouse.' }, event);
  }

  const adapter = getClearinghouse();

  // Assemble the same normalized context submitClaim used, so the status request
  // mirrors the 837 that was filed (subscriber = policyholder, billing provider,
  // dates of service). Adapters never touch the DB.
  const ctx = await buildClaimContext(practiceId, claim);

  let status;
  try {
    status = await adapter.getStatus({ control_number: claim.control_number, claim, ctx });
  } catch (err) {
    // (c) Upstream failure — network/timeout, or a required field the adapter
    // named as missing. Keep the user-facing message generic (it can echo PHI).
    console.error('claims refresh (clearinghouse) error:', err && err.message);
    return json(502, { error: 'Clearinghouse status check failed.' }, event);
  }

  // (b) Valid response, but the payer has no matching claim / no new status yet.
  // The claim keeps its current status; return 200 so the UI can show an info
  // message ("Payer has no update yet") rather than a scary error.
  if (!status || status.no_update) {
    await audit(event, authCtx, {
      action: 'claim.refresh',
      resourceType: 'claim',
      resourceId: id,
      metadata: { status: claim.status, outcome: 'no_update' },
    });
    return json(200, {
      claim: shapeClaim(claim),
      outcome: 'no_update',
      message: 'Payer has no update yet.',
    }, event);
  }

  const newStatus = status.status;
  if (!CLAIM_STATUSES.includes(newStatus)) {
    console.error('claims refresh: adapter returned unknown status');
    return json(502, { error: 'Clearinghouse returned an unrecognized status.' }, event);
  }

  // Coalesce optional amounts; ignore anything that isn't a valid money value.
  const amount = (v) => {
    const p = parseMoney(v);
    return p.ok ? p.value : null;
  };

  const changed = newStatus !== claim.status;

  const updated = await db.withTransaction(async (client) => {
    const res = await client.query(
      `update claims
          set status = $1,
              allowed_amount = coalesce($2, allowed_amount),
              reimbursed_amount = coalesce($3, reimbursed_amount),
              patient_responsibility = coalesce($4, patient_responsibility),
              denial_reason = coalesce($5, denial_reason)
        where id = $6 and practice_id = $7 and is_hidden = false
        returning *`,
      [
        newStatus,
        amount(status.allowed_amount),
        amount(status.reimbursed_amount),
        amount(status.patient_responsibility),
        cleanText(status.denial_reason),
        id,
        practiceId,
      ]
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    if (changed) {
      await logEvent(client, {
        practiceId,
        claimId: row.id,
        createdBy: userId,
        eventType: eventTypeForStatus(newStatus),
        statusFrom: claim.status,
        statusTo: newStatus,
        note: 'Status updated from payer response.',
        payload: status.raw,
      });
    }
    // Persist every claim-status (276/277) payload we receive verbatim, whether or
    // not it changed our status — this is the passive dataset, stored not acted on.
    await logAck(client, {
      practiceId,
      claimId: row.id,
      source: adapter.name,
      kind: 'status',
      controlNumber: claim.control_number,
      payload: status.raw,
    });
    return row;
  });

  if (!updated) return json(404, { error: 'Not found' }, event);
  await audit(event, authCtx, {
    action: 'claim.refresh',
    resourceType: 'claim',
    resourceId: id,
    metadata: { status: updated.status, outcome: changed ? 'updated' : 'no_update' },
  });

  // (a) Status updated, or (b) a valid response that matched our current status
  // with no change. Both are 200; the outcome/message let the UI pick the toast.
  return json(200, {
    claim: shapeClaim(updated),
    outcome: changed ? 'updated' : 'no_update',
    message: changed ? 'Status updated from payer response.' : 'Payer has no update yet.',
  }, event);
}

async function voidClaim(practiceId, userId, id, event, authCtx) {
  if (!isUUID(id)) return json(404, { error: 'Not found' }, event);
  const claim = await loadClaim(practiceId, id);
  if (!claim) return json(404, { error: 'Not found' }, event);
  if (claim.status === 'paid' || claim.status === 'void') {
    return json(409, { error: 'Paid or already-void claims cannot be voided.' }, event);
  }

  // Local state change only. Clearinghouse-side cancellation (Claim.MD /archive/
  // or a void claim upload) is out of scope for this increment.
  const updated = await db.withTransaction(async (client) => {
    const res = await client.query(
      `update claims set status = 'void'
        where id = $1 and practice_id = $2 and is_hidden = false
        returning *`,
      [id, practiceId]
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    await logEvent(client, {
      practiceId,
      claimId: row.id,
      createdBy: userId,
      eventType: 'voided',
      statusFrom: claim.status,
      statusTo: 'void',
      note: 'Claim voided.',
    });
    return row;
  });

  if (!updated) return json(404, { error: 'Not found' }, event);
  await audit(event, authCtx, {
    action: 'claim.void',
    resourceType: 'claim',
    resourceId: id,
  });
  return json(200, { claim: shapeClaim(updated) }, event);
}

// POST /claims/{id}/replace — create a CMS frequency-7 REPLACEMENT of an accepted
// claim. The {id} claim is the ORIGINAL (payer-accepted) claim; this creates a NEW
// draft claim on the same session carrying the durable replacement intent
// (submission_frequency_code '7', the payer's original claim number, corrects_claim_id).
// It does NOT submit — the operator reviews the new draft and submits it through the
// normal submit path, which emits frequency 7, shows the replacement confirm dialog,
// and runs the safety gate. Frequency 7 ONLY (void / frequency 8 is a later change).
async function replaceClaim(practiceId, userId, id, body, event, authCtx) {
  if (!isUUID(id)) return json(404, { error: 'Not found' }, event);
  const original = await loadClaim(practiceId, id);
  if (!original) return json(404, { error: 'Not found' }, event);

  // Only a claim the payer accepted can be replaced: it must have been successfully
  // transmitted (has a control number) and be in an accepted lifecycle state. Denied
  // claims take the correction/appeal path; draft/void were never accepted.
  if (!REPLACEABLE_STATUSES.includes(original.status) || !cleanText(original.control_number)) {
    return json(409, {
      error: 'Only a claim the payer has accepted can be replaced. Denied claims are corrected or appealed; drafts are edited directly.',
    }, event);
  }

  // The payer's ORIGINAL claim number is entered explicitly by the operator (from
  // the EOB / 277CA / 835). We deliberately do NOT auto-parse it from the stored
  // acknowledgments in v1 — allow explicit entry only.
  const payerClaimControlNumber = cleanText(body && body.payer_claim_control_number);
  if (!payerClaimControlNumber) {
    return json(400, {
      error: "The payer's original claim number is required to file a replacement.",
    }, event);
  }

  // One live replacement per original: refuse if a non-hidden, non-void replacement
  // of this claim already exists (a draft in progress or an already-submitted one).
  // A voided replacement does not count, so a bad attempt can be voided and redone.
  const existing = await db.query(
    `select 1 from claims
      where practice_id = $1 and corrects_claim_id = $2 and is_hidden = false and status <> 'void'
      limit 1`,
    [practiceId, id]
  );
  if (existing.rowCount > 0) {
    return json(409, { error: 'A replacement for this claim already exists.' }, event);
  }

  const created = await db.withTransaction(async (client) => {
    return insertReplacementClaim(client, {
      practiceId,
      original,
      payerClaimControlNumber,
      createdBy: userId,
    });
  });

  await audit(event, authCtx, {
    action: 'claim.replace_create',
    resourceType: 'claim',
    resourceId: created.id,
    // ids / field names only — never the payer claim number (PHI-adjacent).
    metadata: { corrects_claim_id: id },
  });
  return json(201, { claim: shapeClaim(created) }, event);
}

// Claim statuses whose derived fields may be regenerated from the underlying
// session. A draft has not been sent yet; a denied claim is being corrected for
// resubmission/appeal. Everything else (submitted/processing/paid/void/...) is
// read-only from the session's point of view — void/refresh are the paths there.
const REGENERATABLE_STATUSES = ['draft', 'denied'];

// Regenerate a claim's session-derived fields after its session was edited (the
// "Edit claim" flow opens the session, saves it, then calls this). Today the only
// derived field is billed_amount = session.fee; keeping it in one server-side
// place means the browser never recomputes money over claim rows.
async function regenerateClaim(practiceId, userId, id, event, authCtx) {
  if (!isUUID(id)) return json(404, { error: 'Not found' }, event);
  const claim = await loadClaim(practiceId, id);
  if (!claim) return json(404, { error: 'Not found' }, event);
  if (!REGENERATABLE_STATUSES.includes(claim.status)) {
    return json(409, { error: 'Only draft or denied claims can be regenerated from their session.' }, event);
  }

  const session = await loadSession(practiceId, claim.session_id);
  if (!session) {
    return json(409, { error: 'The claim\'s session no longer exists.' }, event);
  }

  const billedAmount = session.fee != null ? session.fee : null;

  const updated = await db.withTransaction(async (client) => {
    const res = await client.query(
      `update claims set billed_amount = $1
        where id = $2 and practice_id = $3 and is_hidden = false and status = any($4)
        returning *`,
      [billedAmount, id, practiceId, REGENERATABLE_STATUSES]
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    await logEvent(client, {
      practiceId,
      claimId: row.id,
      createdBy: userId,
      eventType: 'note',
      note: 'Claim fields regenerated from the updated session.',
    });
    return row;
  });

  if (!updated) return json(409, { error: 'Claim is no longer in a regeneratable state.' }, event);
  await audit(event, authCtx, {
    action: 'claim.regenerate',
    resourceType: 'claim',
    resourceId: id,
  });
  return json(200, { claim: shapeClaim(updated) }, event);
}

async function listEvents(practiceId, id, event) {
  if (!isUUID(id)) return json(404, { error: 'Not found' }, event);
  const claim = await loadClaim(practiceId, id);
  if (!claim) return json(404, { error: 'Not found' }, event);
  const res = await db.query(
    `select * from claim_events
      where claim_id = $1 and practice_id = $2
      order by created_at asc`,
    [id, practiceId]
  );
  return json(200, { claim_events: res.rows.map(shapeEvent) }, event);
}

// --- entrypoint --------------------------------------------------------------

// Exported for unit testing (Lambda only calls .handler): the billing-address
// guard and the set of statuses whose claims may be regenerated from a session.
//
// The pure validators below are RE-EXPORTS of lib/claim_readiness.js — this
// handler owns none of them any more. The names are kept because they are the
// long-standing test surface; the implementations are the shared ones, so a test
// against either module tests the same code.
exports.missingBillingAddressField = missingBillingAddressField;
exports.missingSubscriberField = missingSubscriberField;
exports.missingDependentPolicyholderField = missingDependentPolicyholderField;
exports.invalidSessionPlaceOfService = invalidSessionPlaceOfService;
exports.missingBilledAmount = missingBilledAmount;
exports.missingSessionCptCode = missingSessionCptCode;
exports.missingDiagnosisCodes = missingDiagnosisCodes;
exports.excessDiagnosisCodes = excessDiagnosisCodes;
exports.missingPayerId = missingPayerId;
exports.evaluateSubmissionWarnings = evaluateSubmissionWarnings;
exports.ageInYears = ageInYears;
exports.REGENERATABLE_STATUSES = REGENERATABLE_STATUSES;
exports.REPLACEABLE_STATUSES = REPLACEABLE_STATUSES;
exports.isReplacementClaim = isReplacementClaim;
exports.submissionOutcomeUnknown = submissionOutcomeUnknown;
exports.clearinghouseFailureClass = clearinghouseFailureClass;
// Pure shapers exported for unit testing (no DB / network).
exports.shapeClaim = shapeClaim;
exports.shapeClaimDetail = shapeClaimDetail;

exports.handler = async (event) => {
  const method = httpMethod(event);
  if (method === 'OPTIONS') {
    return preflight(event);
  }

  let auth;
  try {
    auth = requireAuth(event);
  } catch (err) {
    return json(err.statusCode || 401, { error: 'Unauthorized' }, event);
  }

  try {
    const practiceId = await loadPracticeId(auth.user.sub);
    if (!practiceId) {
      return json(401, { error: 'Unauthorized' }, event);
    }
    const userId = auth.user.sub;
    // `role` rides along for the submit endpoint's test-submission guard; audit()
    // reads named fields off authCtx, so the extra key is inert everywhere else.
    const authCtx = { userId, practiceId, role: auth.user.role || null };
    const id = pathId(event);
    const action = subAction(event);
    const body = method === 'POST' || method === 'PATCH' ? parseBody(event) : null;

    // Action sub-routes (id always present) take precedence over base CRUD.
    if (action === 'submit' && method === 'POST' && id) return await submitClaim(practiceId, userId, id, body, event, authCtx);
    if (action === 'replace' && method === 'POST' && id) return await replaceClaim(practiceId, userId, id, body, event, authCtx);
    if (action === 'refresh' && method === 'POST' && id) return await refreshClaim(practiceId, userId, id, event, authCtx);
    if (action === 'reconcile' && method === 'POST' && id) return await reconcileClaim(practiceId, userId, id, body, event, authCtx);
    if (action === 'void' && method === 'POST' && id) return await voidClaim(practiceId, userId, id, event, authCtx);
    if (action === 'regenerate' && method === 'POST' && id) return await regenerateClaim(practiceId, userId, id, event, authCtx);
    if (action === 'events' && method === 'GET' && id) return await listEvents(practiceId, id, event);

    if (method === 'POST' && !id) return await createClaim(practiceId, userId, body, event, authCtx);
    if (method === 'GET' && !id) return await listClaims(practiceId, event, authCtx);
    if (method === 'GET' && id) return await getClaim(practiceId, id, event, authCtx);
    if (method === 'PATCH' && id) return await updateClaim(practiceId, id, body, event, authCtx);
    if (method === 'DELETE' && id) return await deleteClaim(practiceId, id, event, authCtx);

    return json(405, { error: 'Method not allowed' }, event);
  } catch (err) {
    console.error('claims error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
