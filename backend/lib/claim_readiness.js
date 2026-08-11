'use strict';

// Shared claim readiness rules — the SINGLE implementation of every pure
// pre-submission check, used by both paths that need them:
//
//   1. POST /claims/{id}/submit  (backend/handlers/claims.js) — the safety gate.
//      It calls these functions individually, in its own long-standing order,
//      because that order is interleaved with DB reads and a mutation (the
//      patient control number is minted between the missing-insurance blocker
//      and the context blockers) and that interleaving is a production contract.
//   2. GET /claims                — the additive readiness PROJECTION on draft
//      rows, via evaluateClaimReadiness() below, which composes the exact same
//      functions over a normalized context.
//
// The projection is a COMPOSITION of the submit-time checks, never a second
// copy: two copies would drift, and a list that says "ready" while submit says
// "blocked" (or the reverse) is worse than no projection at all. If you add a
// rule here it applies to both paths by construction. Adding a rule to only one
// of them is the mistake this module exists to prevent.
//
// The projection is ADVISORY. It does not replace clinician verification and it
// does not replace the submit-time gate: submit re-runs every check against the
// live rows at the moment of submission, plus the DB-dependent replacement gates
// that deliberately live nowhere else (see evaluateClaimReadiness's doc below).
//
// Everything here is PURE and DB-free (no queries, no clock beyond an injectable
// `asOf`), so it is unit-testable and safe to run per row over a list result.
// Messages are non-PHI: they name FIELDS and, in one case, an age — never a
// patient name, member id, DOB, or diagnosis. This module never logs.

const { PLACE_OF_SERVICE_CODES, isValidPlaceOfService } = require('./place_of_service');

// --- hard blockers (submission is refused) -----------------------------------

// A claim cannot be built without coverage to bill. Checked on the CLAIM row
// (insurance_record_id), not on a loaded record — submit runs this BEFORE it
// touches the database for context, and before it mints the patient control
// number, so a claim with no coverage is never mutated by a submit attempt.
// Returns true when the claim has no insurance record attached.
function missingInsuranceRecord(claim) {
  return !claim || claim.insurance_record_id == null || String(claim.insurance_record_id).trim() === '';
}

// A practice needs a complete billing address before a claim can be submitted:
// Stedi's 837P Billing.address requires address1 / city / state / postalCode
// (address2 is optional). Missing any of these makes Stedi reject with a 400
// ("Billing.address: missing field `address1`"); we catch it first and return a
// clear 422 so staff know to fill in Practice Settings. Returns the first missing
// field name, or null when the address is complete.
function missingBillingAddressField(practice) {
  if (!practice) return 'address1';
  const required = [
    ['address_line1', 'address1'],
    ['city', 'city'],
    ['state', 'state'],
    ['postal_code', 'zip'],
  ];
  for (const [col, label] of required) {
    const v = practice[col];
    if (v == null || String(v).trim() === '') return label;
  }
  return null;
}

// The subscriber (patient) needs a date of birth before a claim can be built:
// the 837P subscriber loop requires it, and without it Stedi rejects the claim.
// DOB is collected from the client themselves in the SMS intake, so a
// staff-created client may have none yet — we catch that here and return a clear
// 422 (fill in DOB on the client chart) instead of letting the submission reach
// the clearinghouse and 500/502. Returns the missing field name, or null.
function missingSubscriberField(client) {
  if (!client) return 'date_of_birth';
  const dob = client.date_of_birth;
  if (dob == null || String(dob).trim() === '') return 'date_of_birth';
  return null;
}

// When the patient is a dependent on someone else's policy (the insurance record
// names a subscriber_relationship other than 'self'), the 837P puts the
// POLICYHOLDER in the subscriber loop and requires their name + date of birth.
// Those come from the insurance record (subscriber_name / subscriber_dob), which
// may be blank on a staff-created record — catch it here as a clean 422 rather
// than letting Stedi reject with an opaque error. Returns true when the record is
// a dependent record missing the policyholder name or DOB.
function missingDependentPolicyholderField(insurance) {
  if (!insurance) return false;
  const rel = insurance.subscriber_relationship;
  const isDependent =
    rel != null && String(rel).trim() !== '' && String(rel).trim().toLowerCase() !== 'self';
  if (!isDependent) return false;
  const name = insurance.subscriber_name;
  const dob = insurance.subscriber_dob;
  if (name == null || String(name).trim() === '') return true;
  if (dob == null || String(dob).trim() === '') return true;
  return false;
}

// The session's place_of_service, when present, must be a valid two-character
// CMS code (lib/place_of_service.js) — the payer rejects anything else at the
// front door (837P 2300/CLM-05-01). Empty is fine: the adapter defaults it to 11
// (office). Returns the offending trimmed value, or null when submittable.
// Handler validation (handlers/sessions.js) makes new bad values unsaveable;
// this catches rows written before that validation existed.
function invalidSessionPlaceOfService(session) {
  if (!session || session.place_of_service == null) return null;
  const pos = String(session.place_of_service).trim();
  if (pos === '' || isValidPlaceOfService(pos)) return null;
  return pos;
}

// --- billable CONTENT blockers -----------------------------------------------
//
// The blockers above are all SETUP and demographics: coverage, addresses, dates
// of birth. They say nothing about what the claim actually BILLS, so a claim
// with no charge, no procedure code, no diagnosis, or no routable payer passed
// the gate and was rejected downstream. Two of those are worse than a rejection:
// a missing payer id and an over-limit diagnosis list make the adapter throw
// while BUILDING the body — which happens after the claim has already been moved
// to 'submitted' (handlers/claims.js) — so the claim strands in a retry-blocked
// state though nothing was ever transmitted. These five run PRE-submit, while the
// claim is still a draft, so that path is never reached in normal operation.
//
// The adapter keeps its own throws as a backstop for direct callers; these
// blockers exist so normal flow never gets there.

// Claim-level diagnosis cardinality: the 837P takes 1–12 entries (the first is
// principal, the rest secondary). Restated here rather than imported from the
// Stedi adapter — this module is pure and clearinghouse-agnostic, and the limit
// is the transaction set's, not the vendor's.
const MAX_CLAIM_DIAGNOSES = 12;

// Normalize stored ICD-10 codes the way the wire builder does — uppercase, strip
// everything but A-Z/0-9, drop blanks, de-duplicate preserving order — so the
// count this module blocks on is the count that would actually be transmitted.
// Same rule as normalizeDiagnosisCodes() in lib/clearinghouse/stedi.js.
function normalizeDiagnosisCodes(codes) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(codes) ? codes : []) {
    const code = String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

// A claim with no charge cannot be billed: the 837P claimChargeAmount (and the
// service line's own charge) come straight from claims.billed_amount, and when it
// is null the claim goes out with NO charge amount at all. Zero is equally
// unbillable. Returns true when the claim carries no positive billed amount.
// Deliberately only VALIDATES — it never derives or back-fills the amount; the
// remedy is the existing "Edit claim → Save & regenerate" path.
function missingBilledAmount(claim) {
  if (!claim) return true;
  const raw = claim.billed_amount;
  if (raw == null || String(raw).trim() === '') return true;
  const amount = Number(raw);
  return !Number.isFinite(amount) || amount <= 0;
}

// A professional claim needs a procedure code: with no session cpt_code the
// builder emits no service line at all, so the payer receives a claim that bills
// nothing. Returns true when the session carries no CPT code.
function missingSessionCptCode(session) {
  if (!session) return true;
  const cpt = session.cpt_code;
  return cpt == null || String(cpt).trim() === '';
}

// Every claim must declare at least one diagnosis. The builder falls back to a
// placeholder code when the session stored none — a fabricated clinical fact we
// must never transmit — so a claim with no diagnosis is blocked here instead.
// Returns true when the session has no usable diagnosis code.
function missingDiagnosisCodes(session) {
  return normalizeDiagnosisCodes(session && session.diagnosis_codes).length === 0;
}

// The 837P declares at most 12 claim-level diagnoses. Over the limit the claim
// cannot be built at all (the adapter refuses rather than silently dropping
// codes), so block it while the claim is still editable. Returns the (normalized)
// count when it exceeds the limit, or null when the list fits.
function excessDiagnosisCodes(session) {
  const count = normalizeDiagnosisCodes(session && session.diagnosis_codes).length;
  return count > MAX_CLAIM_DIAGNOSES ? count : null;
}

// The payer id is what ROUTES the claim: it becomes the 837P
// tradingPartnerServiceId, and without it the submission cannot be addressed to
// anyone. It is normally captured during intake / benefits check, but a
// hand-entered insurance record may carry a carrier name and no payer id.
// Returns true when an attached record has no payer id.
//
// A NULL record is not this blocker's business — that is missingInsuranceRecord's
// case (no coverage attached), and on the list projection it is also how a HIDDEN
// insurance record presents, which the projection has always treated as absent.
function missingPayerId(insurance) {
  if (!insurance) return false;
  const payerId = insurance.payer_id;
  return payerId == null || String(payerId).trim() === '';
}

// --- blocker vocabulary ------------------------------------------------------
//
// The exact user-facing text of every hard blocker, in ONE place, so the submit
// response and the list projection are byte-identical by construction. These
// strings are a production contract: staff (and our tests) match on them. Do not
// reword one without the other — there is only one.

const BLOCKER_MESSAGES = {
  missing_insurance_record: 'Attach an insurance record before submitting.',
  practice_billing_address: 'Practice billing address is required before submitting claims.',
  client_date_of_birth:
    "Client date of birth is required before submitting claims. Ask the client to complete intake, or add it on the client's chart.",
  dependent_policyholder:
    'Policyholder name and date of birth are required on the insurance record before submitting a dependent claim. Edit the client\'s insurance to add them.',
  claim_billed_amount:
    'This claim has no billed amount — set the session rate and use Edit claim → Save & regenerate.',
  session_cpt_code: 'This claim has no CPT/procedure code — add it on the session.',
  claim_diagnosis_codes: 'This claim has no diagnosis code — add at least one on the session.',
  claim_diagnosis_limit: 'A claim can carry at most 12 diagnosis codes.',
  insurance_payer_id:
    "This client's insurance has no routable payer ID — re-run intake or set the payer on the insurance record.",
};

// The place-of-service message enumerates the accepted codes, so it is built
// rather than stored. Same builder on both paths.
function placeOfServiceBlockerMessage() {
  return `Session place of service is not a valid CMS code. Edit the session and pick one of: ${
    PLACE_OF_SERVICE_CODES.map((e) => `${e.code} (${e.label})`).join(', ')}.`;
}

// HTTP status each blocker returns from submit. Missing insurance predates the
// 422 blockers and answers 400; the context and content blockers answer 422. The
// projection carries the status through so the UI (and any future caller) can
// see exactly what submit would answer.
const BLOCKER_STATUS = {
  missing_insurance_record: 400,
  practice_billing_address: 422,
  client_date_of_birth: 422,
  dependent_policyholder: 422,
  session_place_of_service: 422,
  claim_billed_amount: 422,
  session_cpt_code: 422,
  claim_diagnosis_codes: 422,
  claim_diagnosis_limit: 422,
  insurance_payer_id: 422,
};

function blocker(code, message) {
  return { code, message, status: BLOCKER_STATUS[code] };
}

// --- pre-submission sanity warnings (soft; NEVER hard-block) -----------------
//
// Computed from the LIVE client + insurance records. These surface likely intake
// mistakes (a parent completing a minor's intake with their own DOB, a member id
// carrying extra card-prefix digits, an adult tagged as a child dependent) that
// nothing else catches. They are advisory: submit proceeds when the caller passes
// confirmed:true. Messages may embed non-PHI context (an age); only the CODES are
// ever written to the audit log.

// Date-only key ('YYYY-MM-DD') for a pg date (JS Date or 'YYYY-MM-DD…' string), or null.
function dateOnlyKey(v) {
  if (v == null || v === '') return null;
  const iso = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

// Whole years between a date of birth and a reference date (default: now, UTC).
// Null when the DOB can't be parsed. UTC math avoids timezone drift (Lambda = UTC).
function ageInYears(dob, asOf) {
  const key = dateOnlyKey(dob);
  if (!key) return null;
  const [by, bm, bd] = key.split('-').map(Number);
  const ref = asOf instanceof Date ? asOf : new Date();
  let age = ref.getUTCFullYear() - by;
  const monthDelta = (ref.getUTCMonth() + 1) - bm;
  if (monthDelta < 0 || (monthDelta === 0 && ref.getUTCDate() < bd)) age -= 1;
  return age;
}

// Evaluate soft pre-submission warnings from { client, insurance }. Returns an
// array of { code, message }. Pure and DB-free so it can be unit-tested; the
// `asOf` param (default now) makes the age rule deterministic in tests.
function evaluateSubmissionWarnings(ctx, asOf) {
  const client = (ctx && ctx.client) || null;
  const insurance = (ctx && ctx.insurance) || null;
  const warnings = [];

  const rel = insurance && insurance.subscriber_relationship
    ? String(insurance.subscriber_relationship).trim().toLowerCase()
    : '';
  const isDependent = rel !== '' && rel !== 'self';

  // 1. A "child" dependent who is an adult (>= 26) is usually a mis-tagged record.
  if (rel === 'child' && client) {
    const age = ageInYears(client.date_of_birth, asOf);
    if (age != null && age >= 26) {
      warnings.push({
        code: 'child_dependent_adult_age',
        message: `Patient is listed as a child dependent but is ${age} years old.`,
      });
    }
  }

  // 2. Patient and policyholder sharing a DOB on a dependent policy is a red flag
  //    (e.g. a parent who entered their own DOB as the child's).
  if (isDependent && client && insurance) {
    const patientDob = dateOnlyKey(client.date_of_birth);
    const subscriberDob = dateOnlyKey(insurance.subscriber_dob);
    if (patientDob && subscriberDob && patientDob === subscriberDob) {
      warnings.push({
        code: 'patient_policyholder_same_dob',
        message: 'Patient and policyholder have the same date of birth.',
      });
    }
  }

  // 3. A dependent claim with no policyholder name on the insurance record.
  if (isDependent && insurance) {
    const name = insurance.subscriber_name;
    if (name == null || String(name).trim() === '') {
      warnings.push({
        code: 'dependent_missing_policyholder_name',
        message: 'Dependent claim has no policyholder name.',
      });
    }
  }

  // 4. Member ID length outside the usual 5–20 characters (extra card-prefix
  //    digits, a truncated id). Only when a member id is actually present.
  if (insurance) {
    const memberId = insurance.member_id == null ? '' : String(insurance.member_id).trim();
    if (memberId !== '' && (memberId.length < 5 || memberId.length > 20)) {
      warnings.push({
        code: 'member_id_length_unusual',
        message: 'Member ID length looks unusual.',
      });
    }
  }

  return warnings;
}

// The replacement acknowledgment, shared verbatim between submit (which appends
// the payer claim number for its confirm dialog) and the projection (which does
// not — the payer claim number is PHI-adjacent and a list row has no use for it).
const REPLACEMENT_WARNING = {
  code: 'replacement_claim',
  message: 'This replaces a previously accepted payer claim — it does not create a new original claim.',
};

// A claim carries replacement (frequency 7) intent when the durable frequency code
// says so, or when it references the claim it replaces. Either alone is enough to
// route it through the safety gate (both are set together by the /replace flow, but
// checking both means a half-populated row can never slip out as a new original).
function isReplacementClaim(claim) {
  return !!claim && (claim.submission_frequency_code === '7' || claim.corrects_claim_id != null);
}

// --- the projection ----------------------------------------------------------

const READINESS_STATES = ['needs_correction', 'review_warning', 'ready_to_review'];

// Evaluate a claim's readiness over a normalized context:
//
//   { claim, session, client, practice, insurance }
//
// Returns { state, blockers: [{ code, message, status }], warnings: [{ code, message }] }:
//
//   needs_correction  at least one hard blocker — submit would refuse
//   review_warning    no blocker, but a soft warning needs a human's eyes
//   ready_to_review   no currently modeled blocker or warning
//
// The name is deliberately ready_to_REVIEW, not ready_to_submit: it means
// "nothing we model objects to this claim", NOT "this claim is correct". The
// content blockers check that a CPT, diagnosis, amount and payer are PRESENT —
// never that they are the RIGHT ones; a human still verifies that, and submit
// still re-runs every check against the live rows.
//
// Blockers are emitted in submit's order, so the FIRST blocker here is the one
// submit would actually answer with.
//
// Deliberately NOT modeled here (they need database reads submit already does,
// and duplicating them in a list projection would mean either an N+1 or a
// guess): the replacement gates on the payer claim number, the replaced claim's
// accepted state, and prior replacements of the same original. A replacement
// claim is surfaced as a review warning; its gates stay submit-time.
function evaluateClaimReadiness(ctx, asOf) {
  const claim = (ctx && ctx.claim) || null;
  const blockers = [];

  if (missingInsuranceRecord(claim)) {
    blockers.push(blocker('missing_insurance_record', BLOCKER_MESSAGES.missing_insurance_record));
  }
  if (missingBillingAddressField(ctx && ctx.practice)) {
    blockers.push(blocker('practice_billing_address', BLOCKER_MESSAGES.practice_billing_address));
  }
  if (missingSubscriberField(ctx && ctx.client)) {
    blockers.push(blocker('client_date_of_birth', BLOCKER_MESSAGES.client_date_of_birth));
  }
  if (missingDependentPolicyholderField(ctx && ctx.insurance)) {
    blockers.push(blocker('dependent_policyholder', BLOCKER_MESSAGES.dependent_policyholder));
  }
  if (invalidSessionPlaceOfService(ctx && ctx.session) != null) {
    blockers.push(blocker('session_place_of_service', placeOfServiceBlockerMessage()));
  }
  // Billable content — what the claim actually charges for. Appended AFTER the
  // setup/demographic blockers, in submit's order.
  if (missingBilledAmount(claim)) {
    blockers.push(blocker('claim_billed_amount', BLOCKER_MESSAGES.claim_billed_amount));
  }
  if (missingSessionCptCode(ctx && ctx.session)) {
    blockers.push(blocker('session_cpt_code', BLOCKER_MESSAGES.session_cpt_code));
  }
  if (missingDiagnosisCodes(ctx && ctx.session)) {
    blockers.push(blocker('claim_diagnosis_codes', BLOCKER_MESSAGES.claim_diagnosis_codes));
  }
  if (excessDiagnosisCodes(ctx && ctx.session) != null) {
    blockers.push(blocker('claim_diagnosis_limit', BLOCKER_MESSAGES.claim_diagnosis_limit));
  }
  if (missingPayerId(ctx && ctx.insurance)) {
    blockers.push(blocker('insurance_payer_id', BLOCKER_MESSAGES.insurance_payer_id));
  }

  const warnings = evaluateSubmissionWarnings(ctx, asOf);
  if (isReplacementClaim(claim)) {
    warnings.unshift({ code: REPLACEMENT_WARNING.code, message: REPLACEMENT_WARNING.message });
  }

  let state = 'ready_to_review';
  if (blockers.length) state = 'needs_correction';
  else if (warnings.length) state = 'review_warning';

  return { state, blockers, warnings };
}

module.exports = {
  // hard blockers (pure)
  missingInsuranceRecord,
  missingBillingAddressField,
  missingSubscriberField,
  missingDependentPolicyholderField,
  invalidSessionPlaceOfService,
  // billable content blockers (pure)
  MAX_CLAIM_DIAGNOSES,
  normalizeDiagnosisCodes,
  missingBilledAmount,
  missingSessionCptCode,
  missingDiagnosisCodes,
  excessDiagnosisCodes,
  missingPayerId,
  // blocker vocabulary
  BLOCKER_MESSAGES,
  BLOCKER_STATUS,
  placeOfServiceBlockerMessage,
  // soft warnings (pure)
  dateOnlyKey,
  ageInYears,
  evaluateSubmissionWarnings,
  REPLACEMENT_WARNING,
  isReplacementClaim,
  // projection
  READINESS_STATES,
  evaluateClaimReadiness,
};
