'use strict';

// Clients resource — one Lambda for the whole resource, routed internally by
// HTTP method and the presence of an {id} path parameter:
//
//   POST   /clients        → create under the caller's practice
//   GET    /clients        → list the caller's practice's clients (excludes hidden)
//   GET    /clients/{id}    → one client, practice-scoped
//   PATCH  /clients/{id}    → update allowed fields, practice-scoped
//   DELETE /clients/{id}    → soft-delete (is_hidden = true), practice-scoped
//
// Security: practice_id is ALWAYS derived from the authenticated user (loaded
// from the users row), never taken from the request body. Every query is
// filtered by that practice_id so a user can never read or modify another
// practice's clients. Clients are PHI — error logs never include names, DOB,
// or contact info.

const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');
const { normalizeEmail, normalizePhone, parseBody } = require('../lib/util');
const { audit, sanitizeFields } = require('../lib/audit');
// Same parsers the sessions handler uses, so a value stored as a client DEFAULT
// is validated exactly as it would be on the session itself — a default that
// could not legally sit on a session would otherwise seed an unsubmittable claim.
const {
  parseMoney,
  parseProcedureModifiers,
  parsePlaceOfService,
  placeOfServiceError,
} = require('../lib/billing_fields');

// Allowed client.status values — mirror the CHECK constraint in db/schema.sql.
// 'active' == ready for claim submission. Keep in sync with the CHECK in
// db/schema.sql (§5 clients) and the dropdown in public/app/views/clients.js.
const ALLOWED_STATUSES = ['active', 'awaiting_info', 'inactive'];

// Allowed client.gender values — mirror the clients_gender_check CHECK in
// db/schema.sql and the options in the client form (clients.js CLIENT_FIELDS).
// Used for the 837 subscriber demographics required by Stedi.
const ALLOWED_GENDERS = ['male', 'female', 'unknown'];

// Optional nullable free-text columns the client form sends and both create +
// update accept. Kept in one place so the two handlers can't drift (the bug that
// silently dropped the subscriber address, blocking claim submission). gender and
// date_of_birth are validated separately (enum / date); these are plain text.
const OPTIONAL_TEXT_COLUMNS = [
  'preferred_name', 'pronouns',
  'address_line1', 'address_line2', 'city', 'state', 'postal_code',
];

const MAX_DIAGNOSIS_CODES = 12; // CMS-1500 allows up to 12 ICD-10 codes.

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

// --- validation helpers ------------------------------------------------------

// Mirror register's missing(): fields that are absent or blank after trimming.
function missing(fields, body) {
  return fields.filter((f) => !body[f] || String(body[f]).trim() === '');
}

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

// Parse an optional phone field to E.164, or a validation error. Blank/absent
// clears the column (null); anything non-blank must normalize to a valid US
// number. Twilio SMS (the payment-link flow) requires E.164, so we normalize at
// write time rather than trusting whatever format the client sent.
//   -> { ok: true, value: '+1XXXXXXXXXX' | null } | { ok: false }
function parsePhone(v) {
  const s = cleanText(v);
  if (s == null) return { ok: true, value: null };
  const res = normalizePhone(s);
  if (!res.ok) return { ok: false };
  return { ok: true, value: res.value };
}

// Calendar-valid YYYY-MM-DD (rejects e.g. 2020-13-40 before it reaches Postgres).
function isValidDate(s) {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Optional ICD-10 diagnosis codes: absent/null → null; otherwise must be an array
// of non-empty trimmed strings, at most MAX_DIAGNOSIS_CODES. An empty array clears
// the column (stored as null). Mirrors the sessions handler's parser so a client's
// default codes and a session's codes are validated identically.
// Validate the per-client billing defaults present on a request body. Returns
// { ok:true, value:{...columns} } with a null for every key the body did not
// carry, or { ok:false, error } naming the first offending field.
//
// Every value goes through the SAME parser the sessions handler applies to the
// session's own column (lib/billing_fields.js). A default that could not legally
// sit on a session must not be storable as a default either — otherwise the
// first calendar-promoted appointment seeds an unsubmittable claim, and the
// error surfaces at submit time against a payer rather than here against a form.
function parseBillingDefaults(body) {
  const value = {
    default_cpt_code: null,
    default_place_of_service: null,
    default_session_fee: null,
    default_procedure_modifiers: null,
    calendar_display_name: null,
  };

  if ('default_cpt_code' in body) value.default_cpt_code = cleanText(body.default_cpt_code);
  if ('calendar_display_name' in body) value.calendar_display_name = cleanText(body.calendar_display_name);

  if ('default_place_of_service' in body) {
    const pos = parsePlaceOfService(body.default_place_of_service);
    if (!pos.ok) return { ok: false, error: placeOfServiceError().replace('place_of_service', 'default_place_of_service') };
    value.default_place_of_service = pos.value;
  }
  if ('default_session_fee' in body) {
    const fee = parseMoney(body.default_session_fee);
    if (!fee.ok) return { ok: false, error: 'Invalid default_session_fee. Expected a number >= 0.' };
    value.default_session_fee = fee.value;
  }
  if ('default_procedure_modifiers' in body) {
    const mods = parseProcedureModifiers(body.default_procedure_modifiers);
    if (!mods.ok) {
      return { ok: false, error: 'Invalid default_procedure_modifiers. Expected an array of up to 4 two-character alphanumeric codes.' };
    }
    value.default_procedure_modifiers = mods.value;
  }

  return { ok: true, value };
}

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

// --- shaping -----------------------------------------------------------------

// Shape a clients row for the API. All fields belong to the caller's own
// practice, so the full record is safe to return.
function shapeClient(r) {
  if (!r) return null;
  return {
    id: r.id,
    practice_id: r.practice_id,
    primary_clinician_id: r.primary_clinician_id,
    first_name: r.first_name,
    last_name: r.last_name,
    preferred_name: r.preferred_name,
    pronouns: r.pronouns,
    email: r.email,
    phone: r.phone,
    date_of_birth: r.date_of_birth,
    gender: r.gender,
    // Subscriber demographics required by the clearinghouse (Stedi 837P) when the
    // patient is the subscriber — must round-trip so staff edits actually persist.
    address_line1: r.address_line1,
    address_line2: r.address_line2,
    city: r.city,
    state: r.state,
    postal_code: r.postal_code,
    country: r.country,
    diagnosis_codes: r.diagnosis_codes,
    // Per-client billing defaults seeded onto new sessions (calendar promote +
    // manual create). diagnosis_codes above is the fifth member of this set — it
    // predates the others and kept its column name.
    default_cpt_code: r.default_cpt_code,
    default_place_of_service: r.default_place_of_service,
    default_session_fee: r.default_session_fee,
    default_procedure_modifiers: r.default_procedure_modifiers,
    calendar_display_name: r.calendar_display_name,
    status: r.status,
    // Display-only payment-method summary (never the Stripe customer / PM ids).
    payment_method_brand: r.payment_method_brand,
    payment_method_last4: r.payment_method_last4,
    payment_method_exp_month: r.payment_method_exp_month,
    payment_method_exp_year: r.payment_method_exp_year,
    payment_method_set_at: r.payment_method_set_at,
    payment_link_sent_at: r.payment_link_sent_at,
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

// True if clinicianId is an active user within this practice. Guards against
// pointing a client at a clinician from another practice.
async function clinicianInPractice(practiceId, clinicianId) {
  const res = await db.query(
    `select 1 from users where id = $1 and practice_id = $2 and is_active = true limit 1`,
    [clinicianId, practiceId]
  );
  return res.rowCount > 0;
}

// --- handlers ----------------------------------------------------------------

async function createClient(practiceId, body, event, authCtx) {
  const absent = missing(['first_name', 'last_name'], body);
  if (absent.length) {
    return json(400, { error: `Missing required fields: ${absent.join(', ')}` }, event);
  }

  const status = cleanText(body.status);
  if (status && !ALLOWED_STATUSES.includes(status)) {
    return json(400, { error: `Invalid status. Expected one of: ${ALLOWED_STATUSES.join(', ')}` }, event);
  }

  const dob = cleanText(body.date_of_birth);
  if (dob && !isValidDate(dob)) {
    return json(400, { error: 'Invalid date_of_birth. Expected YYYY-MM-DD.' }, event);
  }

  const gender = cleanText(body.gender);
  if (gender && !ALLOWED_GENDERS.includes(gender)) {
    return json(400, { error: `Invalid gender. Expected one of: ${ALLOWED_GENDERS.join(', ')}` }, event);
  }

  const dx = parseDiagnosisCodes(body.diagnosis_codes);
  if (!dx.ok) {
    return json(400, { error: 'Invalid diagnosis_codes. Expected an array of up to 12 non-empty strings.' }, event);
  }

  const primaryClinicianId = cleanText(body.primary_clinician_id);
  if (primaryClinicianId) {
    if (!isUUID(primaryClinicianId)) {
      return json(400, { error: 'Invalid primary_clinician_id.' }, event);
    }
    if (!(await clinicianInPractice(practiceId, primaryClinicianId))) {
      return json(400, { error: 'primary_clinician_id is not a clinician in this practice.' }, event);
    }
  }

  const email = body.email ? normalizeEmail(body.email) : null;

  const phone = parsePhone(body.phone);
  if (!phone.ok) {
    return json(400, { error: 'Invalid phone number. Enter a valid US phone number.' }, event);
  }

  const defaults = parseBillingDefaults(body);
  if (!defaults.ok) return json(400, { error: defaults.error }, event);

  const res = await db.query(
    `insert into clients
       (practice_id, first_name, last_name, preferred_name, pronouns, email, phone,
        date_of_birth, gender, address_line1, address_line2, city, state, postal_code,
        diagnosis_codes, primary_clinician_id, status,
        default_cpt_code, default_place_of_service, default_session_fee,
        default_procedure_modifiers, calendar_display_name)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
             coalesce($17, 'awaiting_info'), $18, $19, $20, $21, $22)
     returning *`,
    [
      practiceId,
      String(body.first_name).trim(),
      String(body.last_name).trim(),
      cleanText(body.preferred_name),
      cleanText(body.pronouns),
      email,
      phone.value,
      dob,
      gender,
      cleanText(body.address_line1),
      cleanText(body.address_line2),
      cleanText(body.city),
      cleanText(body.state),
      cleanText(body.postal_code),
      dx.value,
      primaryClinicianId,
      status,
      defaults.value.default_cpt_code,
      defaults.value.default_place_of_service,
      defaults.value.default_session_fee,
      defaults.value.default_procedure_modifiers,
      defaults.value.calendar_display_name,
    ]
  );

  const created = res.rows[0];
  await audit(event, authCtx, {
    action: 'client.create',
    resourceType: 'client',
    resourceId: created.id,
  });
  return json(201, { client: shapeClient(created) }, event);
}

async function listClients(practiceId, event, authCtx) {
  const res = await db.query(
    `select * from clients
      where practice_id = $1 and is_hidden = false
      order by created_at desc`,
    [practiceId]
  );
  await audit(event, authCtx, {
    action: 'client.list',
    resourceType: 'client',
    metadata: { count: res.rowCount },
  });
  return json(200, { clients: res.rows.map(shapeClient) }, event);
}

async function getClient(practiceId, id, event, authCtx) {
  if (!isUUID(id)) {
    return json(404, { error: 'Not found' }, event);
  }
  const res = await db.query(
    `select * from clients
      where id = $1 and practice_id = $2 and is_hidden = false
      limit 1`,
    [id, practiceId]
  );
  if (res.rowCount === 0) {
    return json(404, { error: 'Not found' }, event);
  }
  await audit(event, authCtx, {
    action: 'client.view',
    resourceType: 'client',
    resourceId: id,
  });
  return json(200, { client: shapeClient(res.rows[0]) }, event);
}

async function updateClient(practiceId, id, body, event, authCtx) {
  if (!isUUID(id)) {
    return json(404, { error: 'Not found' }, event);
  }

  // Snapshot the row before the update so we can record WHICH fields changed
  // (names only, never values). Null when the row does not exist — the UPDATE
  // below then returns 404 and we never audit.
  const beforeRes = await db.query(
    `select * from clients where id = $1 and practice_id = $2 and is_hidden = false limit 1`,
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

  // Required-ish text fields: if present they must be non-empty.
  for (const col of ['first_name', 'last_name']) {
    if (col in body) {
      const v = cleanText(body[col]);
      if (v == null) {
        return json(400, { error: `${col} cannot be empty.` }, event);
      }
      add(col, v);
    }
  }

  // Optional nullable text fields — includes the subscriber address columns the
  // client form sends (address_line1/2, city, state, postal_code). Omitting these
  // is the bug that silently dropped the patient address and blocked claims.
  for (const col of OPTIONAL_TEXT_COLUMNS) {
    if (col in body) add(col, cleanText(body[col]));
  }

  if ('email' in body) {
    add('email', body.email ? normalizeEmail(body.email) : null);
  }

  // Phone normalizes to E.164 (Twilio SMS requires it); a blank clears it, and a
  // non-blank value that can't normalize is a 400 rather than stored garbage.
  if ('phone' in body) {
    const phone = parsePhone(body.phone);
    if (!phone.ok) {
      return json(400, { error: 'Invalid phone number. Enter a valid US phone number.' }, event);
    }
    add('phone', phone.value);
  }

  if ('date_of_birth' in body) {
    const dob = cleanText(body.date_of_birth);
    if (dob && !isValidDate(dob)) {
      return json(400, { error: 'Invalid date_of_birth. Expected YYYY-MM-DD.' }, event);
    }
    add('date_of_birth', dob);
  }

  if ('gender' in body) {
    const gender = cleanText(body.gender);
    if (gender && !ALLOWED_GENDERS.includes(gender)) {
      return json(400, { error: `Invalid gender. Expected one of: ${ALLOWED_GENDERS.join(', ')}` }, event);
    }
    add('gender', gender);
  }

  if ('diagnosis_codes' in body) {
    const dx = parseDiagnosisCodes(body.diagnosis_codes);
    if (!dx.ok) {
      return json(400, { error: 'Invalid diagnosis_codes. Expected an array of up to 12 non-empty strings.' }, event);
    }
    add('diagnosis_codes', dx.value);
  }

  if ('status' in body) {
    const status = cleanText(body.status);
    if (!status || !ALLOWED_STATUSES.includes(status)) {
      return json(400, { error: `Invalid status. Expected one of: ${ALLOWED_STATUSES.join(', ')}` }, event);
    }
    add('status', status);
  }

  // Per-client billing defaults. Each is written ONLY when the request actually
  // carries that key, so a PATCH that names one default cannot blank the other
  // four — the "save these as defaults" control on the session and claim forms
  // sends exactly the fields that form exposes and nothing else, and this is the
  // server-side half of that guarantee.
  for (const key of [
    'default_cpt_code',
    'default_place_of_service',
    'default_session_fee',
    'default_procedure_modifiers',
    'calendar_display_name',
  ]) {
    if (!(key in body)) continue;
    const parsed = parseBillingDefaults({ [key]: body[key] });
    if (!parsed.ok) return json(400, { error: parsed.error }, event);
    add(key, parsed.value[key]);
  }

  if ('primary_clinician_id' in body) {
    const primaryClinicianId = cleanText(body.primary_clinician_id);
    if (primaryClinicianId) {
      if (!isUUID(primaryClinicianId)) {
        return json(400, { error: 'Invalid primary_clinician_id.' }, event);
      }
      if (!(await clinicianInPractice(practiceId, primaryClinicianId))) {
        return json(400, { error: 'primary_clinician_id is not a clinician in this practice.' }, event);
      }
    }
    add('primary_clinician_id', primaryClinicianId);
  }

  if (sets.length === 0) {
    return json(400, { error: 'No updatable fields provided.' }, event);
  }

  // Scope the UPDATE to this practice and exclude hidden (soft-deleted) rows so
  // a deleted client reads as 404. updated_at is maintained by the table trigger.
  params.push(id);
  const idParam = `$${params.length}`;
  params.push(practiceId);
  const practiceParam = `$${params.length}`;

  const res = await db.query(
    `update clients set ${sets.join(', ')}
      where id = ${idParam} and practice_id = ${practiceParam} and is_hidden = false
      returning *`,
    params
  );
  if (res.rowCount === 0) {
    return json(404, { error: 'Not found' }, event);
  }
  await audit(event, authCtx, {
    action: 'client.update',
    resourceType: 'client',
    resourceId: id,
    metadata: { fields_changed: sanitizeFields(before, changes) },
  });
  return json(200, { client: shapeClient(res.rows[0]) }, event);
}

async function deleteClient(practiceId, id, event, authCtx) {
  if (!isUUID(id)) {
    return json(404, { error: 'Not found' }, event);
  }
  // Soft-delete only — never hard-delete a PHI record.
  const res = await db.query(
    `update clients set is_hidden = true
      where id = $1 and practice_id = $2 and is_hidden = false
      returning id`,
    [id, practiceId]
  );
  if (res.rowCount === 0) {
    return json(404, { error: 'Not found' }, event);
  }
  await audit(event, authCtx, {
    action: 'client.delete',
    resourceType: 'client',
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

    if (method === 'POST' && !id) return await createClient(practiceId, body, event, authCtx);
    if (method === 'GET' && !id) return await listClients(practiceId, event, authCtx);
    if (method === 'GET' && id) return await getClient(practiceId, id, event, authCtx);
    if (method === 'PATCH' && id) return await updateClient(practiceId, id, body, event, authCtx);
    if (method === 'DELETE' && id) return await deleteClient(practiceId, id, event, authCtx);

    return json(405, { error: 'Method not allowed' }, event);
  } catch (err) {
    // Never log PHI (names, DOB, contact info) — only a generic message.
    console.error('clients error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
