'use strict';

// Sessions resource — one Lambda for the whole resource, routed internally by
// HTTP method and the presence of an {id} path parameter:
//
//   POST   /sessions        → create under the caller's practice
//   GET    /sessions        → list the caller's practice's sessions (excludes
//                             hidden); optional ?client_id, ?clinician_id, ?status
//   GET    /sessions/{id}    → one session, practice-scoped
//   PATCH  /sessions/{id}    → update allowed fields, practice-scoped
//   DELETE /sessions/{id}    → soft-delete (is_hidden = true), practice-scoped
//
// Security: practice_id is ALWAYS derived from the authenticated user (loaded
// from the users row), never taken from the request body. Every query is
// filtered by that practice_id so a user can never read or modify another
// practice's sessions. client_id and clinician_id must both belong to the
// caller's practice. Sessions hold billing data only (no clinical notes); error
// logs stay generic and never include ids, diagnosis codes, or notes.

const crypto = require('crypto');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');
const { parseBody } = require('../lib/util');
const { audit, sanitizeFields } = require('../lib/audit');
const { generateOccurrenceDates, addMonths, MAX_OCCURRENCES } = require('../lib/recurrence');
const {
  primaryInsuranceForClient,
  sessionHasActiveClaim,
  insertDraftClaim,
} = require('../lib/claims');
const { PLACE_OF_SERVICE_CODES, isValidPlaceOfService } = require('../lib/place_of_service');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SESSION_STATUSES = [
  'scheduled', 'completed', 'claim_ready', 'claim_submitted',
  'awaiting_payment', 'paid', 'no_claim',
];

// Recurrence cadences accepted on POST /sessions. 'none' (or absent) = a single,
// non-recurring session. 'biweekly' is the "every 2 weeks" option.
const RECURRENCE_CADENCES = ['none', 'weekly', 'biweekly'];

// Recurrence windows are capped at 6 months out (validated against session_date).
const RECURRENCE_MAX_MONTHS = 6;

const MAX_DIAGNOSIS_CODES = 12; // CMS-1500 allows up to 12 ICD-10 codes.
const MAX_PROCEDURE_MODIFIERS = 4; // CMS-1500 Box 24D holds up to 4 modifiers per line.

// A procedure modifier (post-normalization) is exactly two alphanumeric characters.
const MODIFIER_RE = /^[A-Z0-9]{2}$/;

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

// --- validation helpers ------------------------------------------------------

function cleanText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function isUUID(v) {
  return typeof v === 'string' && UUID_RE.test(v.trim());
}

function isValidDate(s) {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Optional money: absent/blank → null; otherwise a finite number >= 0.
function parseMoney(v) {
  if (v == null || v === '') return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

// Optional positive integer minutes: absent/blank → null; otherwise integer >= 1.
function parseDuration(v) {
  if (v == null || v === '') return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) return { ok: false };
  return { ok: true, value: n };
}

// Optional session status: absent/blank → null (caller applies default);
// otherwise must be one of the allowed enum values.
function parseStatus(v) {
  if (v == null || v === '') return { ok: true, value: null };
  if (typeof v !== 'string' || !SESSION_STATUSES.includes(v)) return { ok: false };
  return { ok: true, value: v };
}

// Optional ICD-10 diagnosis codes: absent/null → null; otherwise must be an
// array of non-empty trimmed strings, at most MAX_DIAGNOSIS_CODES. An empty
// array clears the column (stored as null).
function parseDiagnosisCodes(v) {
  if (v == null) return { ok: true, value: null };
  if (!Array.isArray(v)) return { ok: false };
  const out = [];
  for (const item of v) {
    if (typeof item !== 'string') return { ok: false };
    const s = item.trim();
    if (s === '') return { ok: false };
    out.push(s);
  }
  if (out.length > MAX_DIAGNOSIS_CODES) return { ok: false };
  return { ok: true, value: out.length === 0 ? null : out };
}

// Optional procedure modifiers (CMS-1500 Box 24D / 837P service line): absent/null
// → null; otherwise must be an array. Each entry is trimmed and uppercased; blanks
// are dropped; every surviving entry must be exactly two alphanumeric characters
// (anything else is a hard 400, not a silent drop). The cleaned list is
// de-duplicated preserving first-seen order and capped at MAX_PROCEDURE_MODIFIERS —
// more than four DISTINCT modifiers is a 400, never a truncation. An empty / all-
// blank array clears the column (stored as null). This normalization is mirrored by
// normalizeProcedureModifiers() in lib/clearinghouse/stedi.js so what is validated
// here is exactly what rides the 837P.
function parseProcedureModifiers(v) {
  if (v == null) return { ok: true, value: null };
  if (!Array.isArray(v)) return { ok: false };
  const out = [];
  const seen = new Set();
  for (const item of v) {
    if (typeof item !== 'string') return { ok: false };
    const code = item.trim().toUpperCase();
    if (code === '') continue;                  // drop blanks
    if (!MODIFIER_RE.test(code)) return { ok: false };
    if (seen.has(code)) continue;               // de-duplicate, preserve order
    seen.add(code);
    out.push(code);
  }
  if (out.length > MAX_PROCEDURE_MODIFIERS) return { ok: false };
  return { ok: true, value: out.length === 0 ? null : out };
}

// Optional place of service (837P 2300/CLM05-01 / CMS-1500 Box 24B): absent/blank
// → null (a session may be saved before billing details are known — exactly what
// calendar-promoted sessions do). Otherwise the trimmed value must be one of the
// two-character CMS codes in lib/place_of_service.js — a free-text value like
// "office" is what got a live claim rejected by the payer ("CLM-05-01 cannot
// exceed 2 characters").
function parsePlaceOfService(v) {
  const s = cleanText(v);
  if (s == null) return { ok: true, value: null };
  if (!isValidPlaceOfService(s)) return { ok: false };
  return { ok: true, value: s };
}

function placeOfServiceError() {
  const allowed = PLACE_OF_SERVICE_CODES.map((e) => `${e.code} (${e.label})`).join(', ');
  return `Invalid place_of_service. Expected one of: ${allowed}.`;
}

// --- shaping -----------------------------------------------------------------

function shapeSession(r) {
  if (!r) return null;
  return {
    id: r.id,
    practice_id: r.practice_id,
    client_id: r.client_id,
    clinician_id: r.clinician_id,
    session_date: r.session_date,
    duration_minutes: r.duration_minutes,
    cpt_code: r.cpt_code,
    diagnosis_codes: r.diagnosis_codes,
    place_of_service: r.place_of_service,
    procedure_modifiers: r.procedure_modifiers,
    fee: r.fee,
    notes: r.notes,
    status: r.status,
    recurrence_group_id: r.recurrence_group_id,
    is_hidden: r.is_hidden,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// --- practice scoping --------------------------------------------------------

async function loadPracticeId(userId) {
  const res = await db.query(
    `select practice_id from users where id = $1 and is_active = true limit 1`,
    [userId]
  );
  return res.rows[0] ? res.rows[0].practice_id : null;
}

// True if clientId is a non-hidden client within this practice.
async function clientInPractice(practiceId, clientId) {
  const res = await db.query(
    `select 1 from clients where id = $1 and practice_id = $2 and is_hidden = false limit 1`,
    [clientId, practiceId]
  );
  return res.rowCount > 0;
}

// True if clinicianId is an active user within this practice.
async function clinicianInPractice(practiceId, clinicianId) {
  const res = await db.query(
    `select 1 from users where id = $1 and practice_id = $2 and is_active = true limit 1`,
    [clinicianId, practiceId]
  );
  return res.rowCount > 0;
}

// --- handlers ----------------------------------------------------------------

async function createSession(practiceId, body, event, authCtx) {
  const clientId = cleanText(body.client_id);
  const clinicianId = cleanText(body.clinician_id);
  const sessionDate = cleanText(body.session_date);

  const missing = [];
  if (!clientId) missing.push('client_id');
  if (!clinicianId) missing.push('clinician_id');
  if (!sessionDate) missing.push('session_date');
  if (missing.length) {
    return json(400, { error: `Missing required fields: ${missing.join(', ')}` }, event);
  }

  if (!isUUID(clientId)) {
    return json(400, { error: 'Invalid client_id.' }, event);
  }
  if (!isUUID(clinicianId)) {
    return json(400, { error: 'Invalid clinician_id.' }, event);
  }
  if (!isValidDate(sessionDate)) {
    return json(400, { error: 'Invalid session_date. Expected YYYY-MM-DD.' }, event);
  }
  if (!(await clientInPractice(practiceId, clientId))) {
    return json(400, { error: 'client_id is not a client in this practice.' }, event);
  }
  if (!(await clinicianInPractice(practiceId, clinicianId))) {
    return json(400, { error: 'clinician_id is not a clinician in this practice.' }, event);
  }

  const duration = parseDuration(body.duration_minutes);
  if (!duration.ok) {
    return json(400, { error: 'Invalid duration_minutes. Expected an integer >= 1.' }, event);
  }
  const fee = parseMoney(body.fee);
  if (!fee.ok) {
    return json(400, { error: 'Invalid fee. Expected a number >= 0.' }, event);
  }
  const dx = parseDiagnosisCodes(body.diagnosis_codes);
  if (!dx.ok) {
    return json(400, { error: 'Invalid diagnosis_codes. Expected an array of up to 12 non-empty strings.' }, event);
  }
  const modifiers = parseProcedureModifiers(body.procedure_modifiers);
  if (!modifiers.ok) {
    return json(400, { error: 'Invalid procedure_modifiers. Expected an array of up to 4 two-character alphanumeric codes.' }, event);
  }
  const status = parseStatus(body.status);
  if (!status.ok) {
    return json(400, { error: `Invalid status. Expected one of: ${SESSION_STATUSES.join(', ')}.` }, event);
  }

  // Recurrence: absent/'none' → a single session (unchanged behavior). Otherwise
  // pre-generate the whole series in one transaction (no cron).
  const recurrence = body.recurrence == null || body.recurrence === ''
    ? 'none'
    : String(body.recurrence);
  if (!RECURRENCE_CADENCES.includes(recurrence)) {
    return json(400, { error: `Invalid recurrence. Expected one of: ${RECURRENCE_CADENCES.join(', ')}.` }, event);
  }

  // Column values shared by every session in the (possibly singleton) series.
  const cptCode = cleanText(body.cpt_code);
  const pos = parsePlaceOfService(body.place_of_service);
  if (!pos.ok) {
    return json(400, { error: placeOfServiceError() }, event);
  }
  const placeOfService = pos.value;
  const notes = cleanText(body.notes);

  if (recurrence === 'none') {
    const res = await db.query(
      `insert into sessions
         (practice_id, client_id, clinician_id, session_date, duration_minutes,
          cpt_code, diagnosis_codes, place_of_service, procedure_modifiers, fee, notes, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, coalesce($12, 'scheduled'))
       returning *`,
      [
        practiceId,
        clientId,
        clinicianId,
        sessionDate,
        duration.value,
        cptCode,
        dx.value,
        placeOfService,
        modifiers.value,
        fee.value,
        notes,
        status.value,
      ]
    );
    const created = res.rows[0];
    await audit(event, authCtx, {
      action: 'session.create',
      resourceType: 'session',
      resourceId: created.id,
    });
    return json(201, { session: shapeSession(created) }, event);
  }

  const endDate = cleanText(body.recurrence_end_date);
  if (!endDate) {
    return json(400, { error: 'recurrence_end_date is required when recurrence is set.' }, event);
  }
  if (!isValidDate(endDate)) {
    return json(400, { error: 'Invalid recurrence_end_date. Expected YYYY-MM-DD.' }, event);
  }
  if (endDate < sessionDate) {
    return json(400, { error: 'recurrence_end_date must be on or after session_date.' }, event);
  }
  if (endDate > addMonths(sessionDate, RECURRENCE_MAX_MONTHS)) {
    return json(400, { error: `recurrence_end_date cannot be more than ${RECURRENCE_MAX_MONTHS} months out.` }, event);
  }

  const dates = generateOccurrenceDates(sessionDate, recurrence, endDate, MAX_OCCURRENCES);
  const groupId = crypto.randomUUID();

  const rows = await db.withTransaction(async (client) => {
    const inserted = [];
    for (let i = 0; i < dates.length; i++) {
      // The first session keeps the caller's status (default scheduled); every
      // generated occurrence is 'scheduled'.
      const rowStatus = i === 0 ? status.value : 'scheduled';
      const res = await client.query(
        `insert into sessions
           (practice_id, client_id, clinician_id, session_date, duration_minutes,
            cpt_code, diagnosis_codes, place_of_service, procedure_modifiers, fee, notes, status,
            recurrence_group_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, coalesce($12, 'scheduled'), $13)
         returning *`,
        [
          practiceId,
          clientId,
          clinicianId,
          dates[i],
          duration.value,
          cptCode,
          dx.value,
          placeOfService,
          modifiers.value,
          fee.value,
          notes,
          rowStatus,
          groupId,
        ]
      );
      inserted.push(res.rows[0]);
    }
    return inserted;
  });

  await audit(event, authCtx, {
    action: 'session.create',
    resourceType: 'session',
    resourceId: rows.length ? rows[0].id : null,
    metadata: { count: rows.length, recurrence_group_id: groupId },
  });
  return json(201, {
    sessions: rows.map(shapeSession),
    count: rows.length,
    recurrence_group_id: groupId,
  }, event);
}

async function listSessions(practiceId, event, authCtx) {
  const params = [practiceId];
  let where = `practice_id = $1 and is_hidden = false`;

  const clientId = queryParam(event, 'client_id');
  if (clientId != null && clientId !== '') {
    if (!isUUID(clientId)) {
      return json(400, { error: 'Invalid client_id.' }, event);
    }
    params.push(clientId);
    where += ` and client_id = $${params.length}`;
  }

  const clinicianId = queryParam(event, 'clinician_id');
  if (clinicianId != null && clinicianId !== '') {
    if (!isUUID(clinicianId)) {
      return json(400, { error: 'Invalid clinician_id.' }, event);
    }
    params.push(clinicianId);
    where += ` and clinician_id = $${params.length}`;
  }

  const status = queryParam(event, 'status');
  if (status != null && status !== '') {
    if (!SESSION_STATUSES.includes(status)) {
      return json(400, { error: `Invalid status. Expected one of: ${SESSION_STATUSES.join(', ')}.` }, event);
    }
    params.push(status);
    where += ` and status = $${params.length}`;
  }

  const res = await db.query(
    `select * from sessions
      where ${where}
      order by session_date desc, created_at desc`,
    params
  );
  await audit(event, authCtx, {
    action: 'session.list',
    resourceType: 'session',
    metadata: { count: res.rowCount },
  });
  return json(200, { sessions: res.rows.map(shapeSession) }, event);
}

async function getSession(practiceId, id, event, authCtx) {
  if (!isUUID(id)) {
    return json(404, { error: 'Not found' }, event);
  }
  const res = await db.query(
    `select * from sessions
      where id = $1 and practice_id = $2 and is_hidden = false
      limit 1`,
    [id, practiceId]
  );
  if (res.rowCount === 0) {
    return json(404, { error: 'Not found' }, event);
  }
  await audit(event, authCtx, {
    action: 'session.view',
    resourceType: 'session',
    resourceId: id,
  });
  return json(200, { session: shapeSession(res.rows[0]) }, event);
}

async function updateSession(practiceId, userId, id, body, event, authCtx) {
  if (!isUUID(id)) {
    return json(404, { error: 'Not found' }, event);
  }

  // client_id is immutable — a session stays attached to its original client.
  if ('client_id' in body) {
    return json(400, { error: 'client_id cannot be changed.' }, event);
  }

  // Snapshot before the update so the audit records WHICH fields changed (names
  // only). Null when the session is absent — the UPDATE 404s and we never audit.
  const beforeRes = await db.query(
    `select * from sessions where id = $1 and practice_id = $2 and is_hidden = false limit 1`,
    [id, practiceId]
  );
  const before = beforeRes.rows[0] || null;

  const sets = [];
  const params = [];
  const changes = {};
  const add = (col, val) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
    changes[col] = val;
  };

  // When true, this PATCH transitions the session into 'completed', which triggers
  // auto-draft-claim creation and an advance to 'claim_ready' (see below).
  let completing = false;

  // clinician_id may be reassigned, but only to a clinician in this practice.
  if ('clinician_id' in body) {
    const clinicianId = cleanText(body.clinician_id);
    if (!clinicianId || !isUUID(clinicianId)) {
      return json(400, { error: 'Invalid clinician_id.' }, event);
    }
    if (!(await clinicianInPractice(practiceId, clinicianId))) {
      return json(400, { error: 'clinician_id is not a clinician in this practice.' }, event);
    }
    add('clinician_id', clinicianId);
  }

  if ('session_date' in body) {
    const sessionDate = cleanText(body.session_date);
    if (!sessionDate || !isValidDate(sessionDate)) {
      return json(400, { error: 'Invalid session_date. Expected YYYY-MM-DD.' }, event);
    }
    add('session_date', sessionDate);
  }

  if ('duration_minutes' in body) {
    const duration = parseDuration(body.duration_minutes);
    if (!duration.ok) {
      return json(400, { error: 'Invalid duration_minutes. Expected an integer >= 1.' }, event);
    }
    add('duration_minutes', duration.value);
  }

  for (const col of ['cpt_code', 'notes']) {
    if (col in body) add(col, cleanText(body[col]));
  }

  if ('place_of_service' in body) {
    const pos = parsePlaceOfService(body.place_of_service);
    if (!pos.ok) {
      return json(400, { error: placeOfServiceError() }, event);
    }
    add('place_of_service', pos.value);
  }

  if ('diagnosis_codes' in body) {
    const dx = parseDiagnosisCodes(body.diagnosis_codes);
    if (!dx.ok) {
      return json(400, { error: 'Invalid diagnosis_codes. Expected an array of up to 12 non-empty strings.' }, event);
    }
    add('diagnosis_codes', dx.value);
  }

  if ('procedure_modifiers' in body) {
    const modifiers = parseProcedureModifiers(body.procedure_modifiers);
    if (!modifiers.ok) {
      return json(400, { error: 'Invalid procedure_modifiers. Expected an array of up to 4 two-character alphanumeric codes.' }, event);
    }
    add('procedure_modifiers', modifiers.value);
  }

  if ('fee' in body) {
    const fee = parseMoney(body.fee);
    if (!fee.ok) {
      return json(400, { error: 'Invalid fee. Expected a number >= 0.' }, event);
    }
    add('fee', fee.value);
  }

  if ('status' in body) {
    const status = parseStatus(body.status);
    if (!status.ok || status.value == null) {
      return json(400, { error: `Invalid status. Expected one of: ${SESSION_STATUSES.join(', ')}.` }, event);
    }
    add('status', status.value);
    completing = status.value === 'completed';
  }

  if (sets.length === 0) {
    return json(400, { error: 'No updatable fields provided.' }, event);
  }

  // Scope the UPDATE to this practice and exclude hidden rows so a deleted
  // session reads as 404. updated_at is maintained by the table trigger.
  params.push(id);
  const idParam = `$${params.length}`;
  params.push(practiceId);
  const practiceParam = `$${params.length}`;

  const updateSql = `update sessions set ${sets.join(', ')}
      where id = ${idParam} and practice_id = ${practiceParam} and is_hidden = false
      returning *`;

  // Simple path: not transitioning to completed — a single UPDATE, unchanged.
  if (!completing) {
    const res = await db.query(updateSql, params);
    if (res.rowCount === 0) {
      return json(404, { error: 'Not found' }, event);
    }
    await audit(event, authCtx, {
      action: 'session.update',
      resourceType: 'session',
      resourceId: id,
      metadata: { fields_changed: sanitizeFields(before, changes) },
    });
    return json(200, { session: shapeSession(res.rows[0]) }, event);
  }

  // Completion path: apply the update, auto-create a draft claim if the session
  // has none yet (idempotent — completing twice never doubles claims), then
  // advance the session to 'claim_ready'. All in one transaction.
  const outcome = await db.withTransaction(async (client) => {
    const upd = await client.query(updateSql, params);
    if (upd.rowCount === 0) return { notFound: true };
    let session = upd.rows[0];

    let claimCreated = false;
    if (!(await sessionHasActiveClaim(client, practiceId, session.id))) {
      const primary = await primaryInsuranceForClient(client, practiceId, session.client_id);
      await insertDraftClaim(client, {
        practiceId,
        session,
        insuranceRecordId: primary ? primary.id : null,
        billedAmount: session.fee,
        createdBy: userId,
      });
      claimCreated = true;
    }

    const adv = await client.query(
      `update sessions set status = 'claim_ready'
        where id = $1 and practice_id = $2 and is_hidden = false
        returning *`,
      [session.id, practiceId]
    );
    if (adv.rowCount > 0) session = adv.rows[0];
    return { session, claimCreated };
  });

  if (outcome.notFound) {
    return json(404, { error: 'Not found' }, event);
  }
  await audit(event, authCtx, {
    action: 'session.update',
    resourceType: 'session',
    resourceId: id,
    metadata: {
      fields_changed: sanitizeFields(before, changes),
      claim_created: outcome.claimCreated,
    },
  });
  return json(200, {
    session: shapeSession(outcome.session),
    claim_created: outcome.claimCreated,
  }, event);
}

async function deleteSession(practiceId, id, event, authCtx) {
  if (!isUUID(id)) {
    return json(404, { error: 'Not found' }, event);
  }
  // Soft-delete only — never hard-delete a billing record tied to PHI.
  const res = await db.query(
    `update sessions set is_hidden = true
      where id = $1 and practice_id = $2 and is_hidden = false
      returning id`,
    [id, practiceId]
  );
  if (res.rowCount === 0) {
    return json(404, { error: 'Not found' }, event);
  }
  await audit(event, authCtx, {
    action: 'session.delete',
    resourceType: 'session',
    resourceId: id,
  });
  return json(200, { deleted: true, id: res.rows[0].id }, event);
}

// --- entrypoint --------------------------------------------------------------

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

    const id = pathId(event);
    const body = method === 'POST' || method === 'PATCH' ? parseBody(event) : null;

    const userId = auth.user.sub;
    const authCtx = { userId, practiceId };

    if (method === 'POST' && !id) return await createSession(practiceId, body, event, authCtx);
    if (method === 'GET' && !id) return await listSessions(practiceId, event, authCtx);
    if (method === 'GET' && id) return await getSession(practiceId, id, event, authCtx);
    if (method === 'PATCH' && id) return await updateSession(practiceId, userId, id, body, event, authCtx);
    if (method === 'DELETE' && id) return await deleteSession(practiceId, id, event, authCtx);

    return json(405, { error: 'Method not allowed' }, event);
  } catch (err) {
    // Never log PHI/billing detail — generic only.
    console.error('sessions error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
