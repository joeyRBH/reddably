'use strict';

// Insurance records resource — one Lambda for the whole resource, routed
// internally by HTTP method and the presence of an {id} path parameter:
//
//   POST   /insurance-records        → create under the caller's practice
//   GET    /insurance-records         → list the caller's practice's records
//                                       (excludes hidden); optional ?client_id filter
//   GET    /insurance-records/{id}     → one record, practice-scoped
//   PATCH  /insurance-records/{id}     → update allowed fields, practice-scoped
//   DELETE /insurance-records/{id}     → soft-delete (is_hidden = true), practice-scoped
//
// Security: practice_id is ALWAYS derived from the authenticated user (loaded
// from the users row), never taken from the request body. Every query is
// filtered by that practice_id so a user can never read or modify another
// practice's records. Out-of-network benefit data is PHI — error logs never
// include member_id, subscriber_name, subscriber_dob, or benefits_raw.

const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');
const { parseBody } = require('../lib/util');
const { audit, sanitizeFields } = require('../lib/audit');
const { normalizeEligibility, computeDiscrepancies } = require('./vob');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- request helpers ---------------------------------------------------------

// HTTP method, tolerant of both API Gateway payload formats (v1 httpMethod,
// v2 requestContext.http.method).
function httpMethod(event) {
  if (!event) return '';
  if (event.httpMethod) return event.httpMethod;
  const ctx = event.requestContext;
  return (ctx && ctx.http && ctx.http.method) || '';
}

// The {id} path parameter, or undefined for collection routes.
function pathId(event) {
  return event && event.pathParameters ? event.pathParameters.id : undefined;
}

// A query-string parameter, or undefined.
function queryParam(event, name) {
  return event && event.queryStringParameters ? event.queryStringParameters[name] : undefined;
}

// --- validation helpers ------------------------------------------------------

// Trim a value to a non-empty string, or null. Used for optional text columns
// so a blank string clears the column rather than storing ''.
function cleanText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function isUUID(v) {
  return typeof v === 'string' && UUID_RE.test(v.trim());
}

// Calendar-valid YYYY-MM-DD (rejects e.g. 2020-13-40 before it reaches Postgres).
function isValidDate(s) {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Optional money: absent/blank → null; otherwise a finite number >= 0.
// Returns { ok, value } so callers can map a failure to a 400.
function parseMoney(v) {
  if (v == null || v === '') return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

// Optional percentage: absent/blank → null; otherwise a finite number 0–100.
function parseRate(v) {
  if (v == null || v === '') return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false };
  return { ok: true, value: n };
}

// Optional boolean: must be a real boolean when present.
function parseBool(v) {
  if (typeof v === 'boolean') return { ok: true, value: v };
  return { ok: false };
}

// Optional payer id: absent/blank → null; otherwise a trimmed string up to 50
// chars (the clearinghouse trading-partner / payer id). Returns { ok, value }.
function parsePayerId(v) {
  if (v == null) return { ok: true, value: null };
  const s = String(v).trim();
  if (s === '') return { ok: true, value: null };
  if (s.length > 50) return { ok: false };
  return { ok: true, value: s };
}

// Optional dependent-subscriber (policyholder) gender: absent/blank → null;
// otherwise must be one of the stored vocabulary, matching both clients.gender and
// the insurance_records_subscriber_gender_check DB constraint. Lower-cased so the
// UI can send 'Female' etc. Returns { ok, value }.
const SUBSCRIBER_GENDERS = new Set(['female', 'male', 'unknown']);
function parseGender(v) {
  if (v == null) return { ok: true, value: null };
  const s = String(v).trim().toLowerCase();
  if (s === '') return { ok: true, value: null };
  if (!SUBSCRIBER_GENDERS.has(s)) return { ok: false };
  return { ok: true, value: s };
}

// The dependent-subscriber (policyholder) columns. These describe the OTHER person
// whose policy the patient rides on; when the patient IS the policyholder
// ('self'), none of them apply and they are cleared so stale policyholder PHI can
// never linger and leak into a later dependent claim. subscriber_relationship is
// intentionally NOT in this list — it holds the 'self' value that triggers the clear.
const POLICYHOLDER_COLS = [
  'subscriber_name',
  'subscriber_dob',
  'subscriber_gender',
  'subscriber_address_line1',
  'subscriber_address_line2',
  'subscriber_city',
  'subscriber_state',
  'subscriber_postal_code',
];

// --- shaping -----------------------------------------------------------------

// Build the compact VOB summary the UI renders from a stored 271 payload,
// reusing the VOB handler's normalization so the persistent card and the live
// modal stay in lockstep. Returns null when no check has been stored. The bulky
// `raw` payload is dropped from the summary — callers still get benefits_raw
// separately, and the summary only needs the normalized fields.
function benefitsSummary(r) {
  if (!r || r.benefits_raw == null) return null;
  const summary = normalizeEligibility(r.benefits_raw, r.member_id);
  if (summary && 'raw' in summary) delete summary.raw;
  return summary;
}

// Re-derive the payer/record discrepancies from the persisted benefits_raw, the
// stored insurance fields, and the joined client demographics — the SAME list the
// VOB check returned live, so the "Payer records differ" panel survives reload and
// self-heals once corrections are applied. Returns [] when there is no stored
// check or the client join is absent (create/update rows carry no client columns).
function benefitsDiscrepancies(r) {
  if (!r || r.benefits_raw == null) return [];
  if (!('client_first_name' in r)) return []; // only the read (list/get) join carries these
  try {
    return computeDiscrepancies(r.benefits_raw, {
      insurance: { member_id: r.member_id, subscriber_name: r.subscriber_name, subscriber_dob: r.subscriber_dob },
      client: { first_name: r.client_first_name, last_name: r.client_last_name, date_of_birth: r.client_dob },
    });
  } catch (e) {
    return [];
  }
}

// Shape an insurance_records row for the API. All fields belong to the caller's
// own practice, so the full record (including PHI) is safe to return to them.
function shapeRecord(r) {
  if (!r) return null;
  return {
    id: r.id,
    practice_id: r.practice_id,
    client_id: r.client_id,
    carrier_name: r.carrier_name,
    member_id: r.member_id,
    group_number: r.group_number,
    plan_type: r.plan_type,
    subscriber_relationship: r.subscriber_relationship,
    subscriber_name: r.subscriber_name,
    subscriber_dob: r.subscriber_dob,
    subscriber_gender: r.subscriber_gender,
    subscriber_address_line1: r.subscriber_address_line1,
    subscriber_address_line2: r.subscriber_address_line2,
    subscriber_city: r.subscriber_city,
    subscriber_state: r.subscriber_state,
    subscriber_postal_code: r.subscriber_postal_code,
    oon_deductible_total: r.oon_deductible_total,
    oon_deductible_met: r.oon_deductible_met,
    oon_reimbursement_rate: r.oon_reimbursement_rate,
    payer_id: r.payer_id,
    benefits_checked_at: r.benefits_checked_at,
    benefits_raw: r.benefits_raw,
    benefits_summary: benefitsSummary(r),
    benefits_discrepancies: benefitsDiscrepancies(r),
    is_primary: r.is_primary,
    is_hidden: r.is_hidden,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// --- practice scoping --------------------------------------------------------

// Derive the caller's practice_id from their (active) users row. Re-loading
// from the DB means a deactivated user can't keep acting on a still-valid token,
// and the practice_id is never trusted from the request.
async function loadPracticeId(userId) {
  const res = await db.query(
    `select practice_id from users where id = $1 and is_active = true limit 1`,
    [userId]
  );
  return res.rows[0] ? res.rows[0].practice_id : null;
}

// True if clientId is a non-hidden client within this practice. Guards against
// attaching insurance to a client from another practice.
async function clientInPractice(practiceId, clientId) {
  const res = await db.query(
    `select 1 from clients where id = $1 and practice_id = $2 and is_hidden = false limit 1`,
    [clientId, practiceId]
  );
  return res.rowCount > 0;
}

// --- handlers ----------------------------------------------------------------

async function createRecord(practiceId, body, event, authCtx) {
  const clientId = cleanText(body.client_id);
  if (!clientId) {
    return json(400, { error: 'Missing required fields: client_id' }, event);
  }
  if (!isUUID(clientId)) {
    return json(400, { error: 'Invalid client_id.' }, event);
  }
  if (!(await clientInPractice(practiceId, clientId))) {
    return json(400, { error: 'client_id is not a client in this practice.' }, event);
  }

  const dob = cleanText(body.subscriber_dob);
  if (dob && !isValidDate(dob)) {
    return json(400, { error: 'Invalid subscriber_dob. Expected YYYY-MM-DD.' }, event);
  }

  const gender = parseGender(body.subscriber_gender);
  if (!gender.ok) {
    return json(400, { error: 'Invalid subscriber_gender. Expected female, male, or unknown.' }, event);
  }

  const total = parseMoney(body.oon_deductible_total);
  if (!total.ok) {
    return json(400, { error: 'Invalid oon_deductible_total. Expected a number >= 0.' }, event);
  }
  const met = parseMoney(body.oon_deductible_met);
  if (!met.ok) {
    return json(400, { error: 'Invalid oon_deductible_met. Expected a number >= 0.' }, event);
  }
  const rate = parseRate(body.oon_reimbursement_rate);
  if (!rate.ok) {
    return json(400, { error: 'Invalid oon_reimbursement_rate. Expected a number between 0 and 100.' }, event);
  }
  const payerId = parsePayerId(body.payer_id);
  if (!payerId.ok) {
    return json(400, { error: 'Invalid payer_id. Expected a string up to 50 characters.' }, event);
  }

  let isPrimary = null;
  if ('is_primary' in body) {
    const b = parseBool(body.is_primary);
    if (!b.ok) {
      return json(400, { error: 'Invalid is_primary. Expected a boolean.' }, event);
    }
    isPrimary = b.value;
  }

  // When the patient IS the policyholder ('self'), never store any policyholder
  // (dependent-subscriber) demographics — they describe a different person and
  // would be a latent leak. A well-behaved client omits them for self already;
  // this makes it structural.
  const relationship = cleanText(body.subscriber_relationship);
  const isSelf = relationship === 'self';
  const subName = isSelf ? null : cleanText(body.subscriber_name);
  const subDob = isSelf ? null : dob;
  const subGender = isSelf ? null : gender.value;
  const subAddr1 = isSelf ? null : cleanText(body.subscriber_address_line1);
  const subAddr2 = isSelf ? null : cleanText(body.subscriber_address_line2);
  const subCity = isSelf ? null : cleanText(body.subscriber_city);
  const subState = isSelf ? null : cleanText(body.subscriber_state);
  const subPostal = isSelf ? null : cleanText(body.subscriber_postal_code);

  // benefits_checked_at and benefits_raw are system-managed — never accepted
  // from the client, so they are left null at creation.
  const res = await db.query(
    `insert into insurance_records
       (practice_id, client_id, carrier_name, member_id, group_number, plan_type,
        subscriber_relationship, subscriber_name, subscriber_dob,
        subscriber_gender, subscriber_address_line1, subscriber_address_line2,
        subscriber_city, subscriber_state, subscriber_postal_code,
        oon_deductible_total, oon_deductible_met, oon_reimbursement_rate, payer_id, is_primary)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16, $17, $18, $19, coalesce($20, true))
     returning *`,
    [
      practiceId,
      clientId,
      cleanText(body.carrier_name),
      cleanText(body.member_id),
      cleanText(body.group_number),
      cleanText(body.plan_type),
      relationship,
      subName,
      subDob,
      subGender,
      subAddr1,
      subAddr2,
      subCity,
      subState,
      subPostal,
      total.value,
      met.value,
      rate.value,
      payerId.value,
      isPrimary,
    ]
  );

  const created = res.rows[0];
  await audit(event, authCtx, {
    action: 'insurance.create',
    resourceType: 'insurance_record',
    resourceId: created.id,
  });
  return json(201, { insurance_record: shapeRecord(created) }, event);
}

async function listRecords(practiceId, event, authCtx) {
  const params = [practiceId];
  let where = `ir.practice_id = $1 and ir.is_hidden = false`;

  const clientId = queryParam(event, 'client_id');
  if (clientId != null && clientId !== '') {
    if (!isUUID(clientId)) {
      return json(400, { error: 'Invalid client_id.' }, event);
    }
    params.push(clientId);
    where += ` and ir.client_id = $${params.length}`;
  }

  // Left-join the client for the demographics the discrepancy re-derivation needs
  // (first/last name, DOB). ir.* keeps every existing record field unchanged.
  const res = await db.query(
    `select ir.*,
            cl.first_name    as client_first_name,
            cl.last_name     as client_last_name,
            cl.date_of_birth as client_dob
       from insurance_records ir
       left join clients cl on cl.id = ir.client_id
      where ${where}
      order by ir.created_at desc`,
    params
  );
  await audit(event, authCtx, {
    action: 'insurance.list',
    resourceType: 'insurance_record',
    metadata: { count: res.rowCount },
  });
  return json(200, { insurance_records: res.rows.map(shapeRecord) }, event);
}

async function getRecord(practiceId, id, event, authCtx) {
  if (!isUUID(id)) {
    return json(404, { error: 'Not found' }, event);
  }
  const res = await db.query(
    `select ir.*,
            cl.first_name    as client_first_name,
            cl.last_name     as client_last_name,
            cl.date_of_birth as client_dob
       from insurance_records ir
       left join clients cl on cl.id = ir.client_id
      where ir.id = $1 and ir.practice_id = $2 and ir.is_hidden = false
      limit 1`,
    [id, practiceId]
  );
  if (res.rowCount === 0) {
    return json(404, { error: 'Not found' }, event);
  }
  await audit(event, authCtx, {
    action: 'insurance.view',
    resourceType: 'insurance_record',
    resourceId: id,
  });
  return json(200, { insurance_record: shapeRecord(res.rows[0]) }, event);
}

async function updateRecord(practiceId, id, body, event, authCtx) {
  if (!isUUID(id)) {
    return json(404, { error: 'Not found' }, event);
  }

  // client_id is immutable — a record stays attached to its original client.
  if ('client_id' in body) {
    return json(400, { error: 'client_id cannot be changed.' }, event);
  }

  // Snapshot the row before the update so we can record WHICH fields changed
  // (names only). Null when absent — the UPDATE then 404s and we never audit.
  const beforeRes = await db.query(
    `select * from insurance_records where id = $1 and practice_id = $2 and is_hidden = false limit 1`,
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

  // Does this request flip the patient's relationship to the policyholder back to
  // 'self'? When it does, every policyholder (dependent-subscriber) column is
  // cleared below, regardless of what the body carries for them — so stale
  // policyholder PHI can never linger on a self policy and leak into a later
  // dependent claim (the coalesce/partial-update idiom would otherwise preserve
  // it, since the form hides and drops those fields on 'self'). The Stedi builder
  // already ignores them on a self claim, but leaving them in the DB is a leak the
  // moment the relationship flips back to a dependent value.
  const flipToSelf =
    'subscriber_relationship' in body && cleanText(body.subscriber_relationship) === 'self';

  // Optional nullable text fields that always apply.
  for (const col of [
    'carrier_name',
    'member_id',
    'group_number',
    'plan_type',
    'subscriber_relationship',
  ]) {
    if (col in body) add(col, cleanText(body[col]));
  }

  // Policyholder (dependent-subscriber) fields. Skipped from the body entirely on
  // a self-flip — they are force-cleared to NULL at the end instead.
  if (!flipToSelf) {
    if ('subscriber_gender' in body) {
      const g = parseGender(body.subscriber_gender);
      if (!g.ok) {
        return json(400, { error: 'Invalid subscriber_gender. Expected female, male, or unknown.' }, event);
      }
      add('subscriber_gender', g.value);
    }

    for (const col of [
      'subscriber_name',
      'subscriber_address_line1',
      'subscriber_address_line2',
      'subscriber_city',
      'subscriber_state',
      'subscriber_postal_code',
    ]) {
      if (col in body) add(col, cleanText(body[col]));
    }

    if ('subscriber_dob' in body) {
      const dob = cleanText(body.subscriber_dob);
      if (dob && !isValidDate(dob)) {
        return json(400, { error: 'Invalid subscriber_dob. Expected YYYY-MM-DD.' }, event);
      }
      add('subscriber_dob', dob);
    }
  }

  if ('oon_deductible_total' in body) {
    const total = parseMoney(body.oon_deductible_total);
    if (!total.ok) {
      return json(400, { error: 'Invalid oon_deductible_total. Expected a number >= 0.' }, event);
    }
    add('oon_deductible_total', total.value);
  }

  if ('oon_deductible_met' in body) {
    const met = parseMoney(body.oon_deductible_met);
    if (!met.ok) {
      return json(400, { error: 'Invalid oon_deductible_met. Expected a number >= 0.' }, event);
    }
    add('oon_deductible_met', met.value);
  }

  if ('oon_reimbursement_rate' in body) {
    const rate = parseRate(body.oon_reimbursement_rate);
    if (!rate.ok) {
      return json(400, { error: 'Invalid oon_reimbursement_rate. Expected a number between 0 and 100.' }, event);
    }
    add('oon_reimbursement_rate', rate.value);
  }

  if ('payer_id' in body) {
    const payerId = parsePayerId(body.payer_id);
    if (!payerId.ok) {
      return json(400, { error: 'Invalid payer_id. Expected a string up to 50 characters.' }, event);
    }
    add('payer_id', payerId.value);
  }

  if ('is_primary' in body) {
    const b = parseBool(body.is_primary);
    if (!b.ok) {
      return json(400, { error: 'Invalid is_primary. Expected a boolean.' }, event);
    }
    add('is_primary', b.value);
  }

  // Flipping to 'self': clear every policyholder column to NULL. These were skipped
  // from the body loop above, so there is no duplicate SET for the same column.
  if (flipToSelf) {
    for (const col of POLICYHOLDER_COLS) add(col, null);
  }

  if (sets.length === 0) {
    return json(400, { error: 'No updatable fields provided.' }, event);
  }

  // Scope the UPDATE to this practice and exclude hidden (soft-deleted) rows so
  // a deleted record reads as 404. updated_at is maintained by the table trigger.
  params.push(id);
  const idParam = `$${params.length}`;
  params.push(practiceId);
  const practiceParam = `$${params.length}`;

  const res = await db.query(
    `update insurance_records set ${sets.join(', ')}
      where id = ${idParam} and practice_id = ${practiceParam} and is_hidden = false
      returning *`,
    params
  );
  if (res.rowCount === 0) {
    return json(404, { error: 'Not found' }, event);
  }
  await audit(event, authCtx, {
    action: 'insurance.update',
    resourceType: 'insurance_record',
    resourceId: id,
    metadata: { fields_changed: sanitizeFields(before, changes) },
  });
  return json(200, { insurance_record: shapeRecord(res.rows[0]) }, event);
}

async function deleteRecord(practiceId, id, event, authCtx) {
  if (!isUUID(id)) {
    return json(404, { error: 'Not found' }, event);
  }
  // Soft-delete only — never hard-delete a PHI record.
  const res = await db.query(
    `update insurance_records set is_hidden = true
      where id = $1 and practice_id = $2 and is_hidden = false
      returning id`,
    [id, practiceId]
  );
  if (res.rowCount === 0) {
    return json(404, { error: 'Not found' }, event);
  }
  await audit(event, authCtx, {
    action: 'insurance.delete',
    resourceType: 'insurance_record',
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
    const authCtx = { userId: auth.user.sub, practiceId };

    if (method === 'POST' && !id) return await createRecord(practiceId, body, event, authCtx);
    if (method === 'GET' && !id) return await listRecords(practiceId, event, authCtx);
    if (method === 'GET' && id) return await getRecord(practiceId, id, event, authCtx);
    if (method === 'PATCH' && id) return await updateRecord(practiceId, id, body, event, authCtx);
    if (method === 'DELETE' && id) return await deleteRecord(practiceId, id, event, authCtx);

    return json(405, { error: 'Method not allowed' }, event);
  } catch (err) {
    // Never log PHI (member_id, subscriber_name/dob, benefits_raw) — generic only.
    console.error('insurance_records error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
