'use strict';

// Shared validation + seeding for the billable fields that a SESSION carries and
// a CLIENT can hold a default for.
//
// These parsers previously lived only in backend/handlers/sessions.js. Clients
// now store per-client defaults for the same fields (clients.default_cpt_code,
// default_place_of_service, default_session_fee, default_procedure_modifiers),
// so the same values are validated on two routes. A second copy of the rules
// would be a second, silently divergent definition of what a valid place of
// service or procedure modifier is — and one of those copies would be the one
// deciding what rides the 837P. They live here once and both handlers import
// them.
//
// Pure: no DB, no request objects, no logging. Every parser returns
// { ok, value } so callers own the HTTP response.

const { PLACE_OF_SERVICE_CODES, isValidPlaceOfService } = require('./place_of_service');

const MAX_PROCEDURE_MODIFIERS = 4; // CMS-1500 Box 24D holds up to 4 modifiers per line.

// A procedure modifier (post-normalization) is exactly two alphanumeric characters.
const MODIFIER_RE = /^[A-Z0-9]{2}$/;

function cleanText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// Optional money: absent/blank → null; otherwise a finite number >= 0.
function parseMoney(v) {
  if (v == null || v === '') return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
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

// --- per-client billing defaults ---------------------------------------------

// The ONLY mapping between a session's billable field and the client column that
// holds its default. Everything that seeds a session, and everything that offers
// to save a value back as a default, reads this map — so the set can never drift
// between the two directions.
//
// diagnosis_codes is the odd one out by name only: clients.diagnosis_codes
// predates the others (migration 008) and already served as the per-client
// default, so it keeps its column name rather than being renamed for symmetry.
const CLIENT_DEFAULT_COLUMNS = Object.freeze({
  cpt_code: 'default_cpt_code',
  place_of_service: 'default_place_of_service',
  fee: 'default_session_fee',
  procedure_modifiers: 'default_procedure_modifiers',
  diagnosis_codes: 'diagnosis_codes',
});

const DEFAULTABLE_SESSION_FIELDS = Object.freeze(Object.keys(CLIENT_DEFAULT_COLUMNS));

// Seed a NEW session's billable fields from the client's stored defaults: any
// field that would otherwise be null takes the client's default. A value the
// caller actually supplied always wins.
//
// This is the whole point of the defaults: a calendar-promoted appointment used
// to arrive with cpt_code / place_of_service / fee / procedure_modifiers all
// NULL, so "just verify the appointment" was never true — every promoted session
// needed billing data typed in before it could become a claim.
//
// CREATE ONLY. Deliberately not used on update: a default is a starting value,
// not a floor, so clearing a field on an existing session must stick rather than
// silently repopulating from the chart on the next save. A blank at creation
// time has no such intent behind it — there is nothing yet to clear — which is
// why filling nulls here is safe and filling them on update would not be.
//
// Returns a NEW object; neither argument is mutated.
function applyClientDefaults(input, client) {
  const out = Object.assign({}, input || {});
  if (!client) return out;
  for (const field of DEFAULTABLE_SESSION_FIELDS) {
    if (out[field] != null) continue;
    const value = client[CLIENT_DEFAULT_COLUMNS[field]];
    if (value != null) out[field] = value;
  }
  return out;
}

module.exports = {
  MAX_PROCEDURE_MODIFIERS,
  cleanText,
  parseMoney,
  parseProcedureModifiers,
  parsePlaceOfService,
  placeOfServiceError,
  CLIENT_DEFAULT_COLUMNS,
  DEFAULTABLE_SESSION_FIELDS,
  applyClientDefaults,
};
