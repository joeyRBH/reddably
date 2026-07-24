'use strict';

// Stedi clearinghouse adapter. GATED: only used when CLEARINGHOUSE=stedi and
// STEDI_API_KEY is set on the Lambda environment. Transport targets Stedi's
// Healthcare medical-network REST API:
//
//   base   : https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork
//   auth   : Authorization: <STEDI_API_KEY>   (raw key, every request)
//   submit : POST {base}/professionalclaims/v3/submission   application/json
//   status : POST {base}/claimstatus/v2                      application/json
//
// Runs on Node 20+ (global fetch). The handler stores whatever submitClaim()
// returns as `raw` into claims.clearinghouse_payload, so we persist the
// tradingPartnerServiceId and billing NPI there for getStatus() to reuse.
//
// NOTE: the request/response field mappings below follow the spec and Stedi's
// published shapes but should be confirmed against a Stedi test account before
// going live. Until validated, keep CLEARINGHOUSE=mock.

const name = 'stedi';
const BASE =
  process.env.STEDI_BASE_URL ||
  'https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork';

// Submitter contact (837P loop 1000A). Reddably is the submitter/clearinghouse
// intermediary, so this is a platform constant rather than per-practice data.
// Stedi requires at least one of phone / email / fax on the submitter contact.
const SUBMITTER_CONTACT_EMAIL =
  process.env.STEDI_SUBMITTER_EMAIL || 'billing@reddably.com';

function apiKey() {
  const k = process.env.STEDI_API_KEY;
  if (!k) {
    throw new Error('STEDI_API_KEY is not set');
  }
  return k;
}

// Bound every Stedi call with a hard timeout. global fetch has no default
// timeout, so a network-path failure (e.g. no egress route to the public API)
// leaves the socket hanging until the Lambda is killed — ~10s of dead air that
// surfaces to the user as an opaque 502. An AbortController fails fast instead,
// with a clear "timed out" error the handler can log. All three Stedi endpoints
// share the same POST + raw-key-auth shape, so they route through here.
const STEDI_TIMEOUT_MS = Number(process.env.STEDI_TIMEOUT_MS || 15000);

async function stediPost(path, body, extraHeaders) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STEDI_TIMEOUT_MS);
  try {
    return await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: apiKey(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(extraHeaders || {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      // Never include the request body — it can carry PHI (member id, name, DOB).
      throw new Error(`Stedi request to ${path} timed out after ${STEDI_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// GET counterpart to stediPost for the read-only endpoints that live outside the
// medical-network base (e.g. the payer-search API). Takes a full URL so the caller
// owns the path + query string. Reuses the exact same 15s AbortController bound and
// PHI-safe timeout message — the URL is never echoed in the error, since a query
// string could in principle carry sensitive terms.
async function stediGet(url, extraHeaders) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STEDI_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: apiKey(),
        Accept: 'application/json',
        ...(extraHeaders || {}),
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`Stedi GET request timed out after ${STEDI_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Format a date (pg `date` → JS Date or 'YYYY-MM-DD' string) as YYYYMMDD, or null.
function ymd(d) {
  if (d == null || d === '') return null;
  const iso = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  const digits = iso.replace(/-/g, '');
  return /^\d{8}$/.test(digits) ? digits : null;
}

// Shift a YYYYMMDD string by N calendar days and return YYYYMMDD. UTC math avoids
// timezone drift. Returns null when the input is not a valid YYYYMMDD.
function shiftYmd(ymdStr, deltaDays) {
  if (!ymdStr || !/^\d{8}$/.test(ymdStr)) return null;
  const dt = new Date(Date.UTC(
    Number(ymdStr.slice(0, 4)),
    Number(ymdStr.slice(4, 6)) - 1,
    Number(ymdStr.slice(6, 8))
  ));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10).replace(/-/g, '');
}

// Today as YYYYMMDD (UTC). Kept as a helper so status-request date capping has a
// single source of "now".
function todayYmd() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

// Map a clients.gender value to the 837 demographic code (M / F / U).
function genderCode(g) {
  switch (g) {
    case 'female':
      return 'F';
    case 'male':
      return 'M';
    default:
      return 'U';
  }
}

// Split an insurance.subscriber_name ("First Last", "First Middle Last") into
// [firstName, lastName] on the LAST space — mirrors the client portal / insurance
// form, which stores the policyholder as a single free-text name. A single token
// (no space) is treated as a first name only, with an empty last name.
function splitSubscriberName(full) {
  const s = full == null ? '' : String(full).trim();
  if (!s) return ['', ''];
  const i = s.lastIndexOf(' ');
  if (i <= 0) return [s, ''];
  return [s.slice(0, i).trim(), s.slice(i + 1).trim()];
}

// Map an insurance.subscriber_relationship (the patient's relationship TO the
// policyholder — allowed values self | spouse | child | other, per the insurance
// form) to the 837P dependent relationshipToSubscriberCode. 'self' never reaches
// here (it means the patient IS the subscriber — no dependent loop). Unknown /
// unrecognized values fall back to G8 (other relationship).
function relationshipToSubscriberCode(rel) {
  switch (String(rel == null ? '' : rel).trim().toLowerCase()) {
    case 'spouse':
      return '01';
    case 'child':
      return '19';
    default:
      return 'G8';
  }
}

// -----------------------------------------------------------------------------
// usageIndicator (837P ISA15) — 'P' production, 'T' test. Top-level on the
// professional-claims request body, per Stedi's test-claims workflow docs.
//
// This field is SAFETY-CRITICAL and asymmetric in both directions:
//   * a 'T' that escapes to production means the payer never adjudicates the
//     claim — the practice is silently never reimbursed, with no rejection to
//     alert anyone.
//   * a 'P' sent during testing means synthetic patient data is filed as a real
//     claim against a real payer.
//
// So the default is 'P' and it is ALWAYS set explicitly — Stedi's docs do not
// state what an omitted usageIndicator defaults to, and this is not a field to
// leave to an implicit default. 'T' is only ever produced through the two
// operator-controlled paths below; nothing a practice user can set reaches it.
// -----------------------------------------------------------------------------
const USAGE_PRODUCTION = 'P';
const USAGE_TEST = 'T';

function envFlag(name) {
  return String(process.env[name] == null ? '' : process.env[name]).trim().toLowerCase() === 'true';
}

// STEDI_FORCE_TEST_SUBMISSIONS marks a NON-PRODUCTION deployment (staging, a
// developer's machine). When set, every claim that environment files goes out as
// 'T' regardless of what the request asked for — staging structurally cannot emit
// a production claim.
//
// STEDI_ALLOW_TEST_SUBMISSIONS is the narrower gate that lets a single request
// opt into 'T' (ctx.testSubmission, set only by the admin-guarded branch of the
// submit handler). It is deliberately a separate variable and deliberately absent
// from the production Lambda config: without it, a forged or mistaken
// testSubmission flag still yields 'P'. Both gates must agree.
function resolveUsageIndicator(ctx) {
  if (envFlag('STEDI_FORCE_TEST_SUBMISSIONS')) return USAGE_TEST;
  const requested = !!(ctx && ctx.testSubmission === true);
  if (requested && envFlag('STEDI_ALLOW_TEST_SUBMISSIONS')) return USAGE_TEST;
  return USAGE_PRODUCTION;
}

// Whether this deployment permits a per-request test submission at all. The
// submit handler asks BEFORE submitting so a test request the environment
// forbids is refused outright rather than silently filed as a production claim.
// Adapters that can't file a test claim (mock, claim_md) simply don't export it.
function testSubmissionsAllowed() {
  return envFlag('STEDI_ALLOW_TEST_SUBMISSIONS') || envFlag('STEDI_FORCE_TEST_SUBMISSIONS');
}

// Claim-level diagnosis cardinality. Stedi's 837P schema takes 1-12 entries in
// healthCareCodeInformation: the first is the principal (ABK), the rest are
// secondary (ABF).
const MAX_CLAIM_DIAGNOSES = 12;

// Service-line diagnosis-pointer cardinality — deliberately NOT the same number.
// A professional service line points at diagnoses through SV107, a composite with
// four sub-elements, so a line carries at most 4 pointers no matter how many
// diagnoses the claim declares. Stedi's schema says the same: one pointer for the
// primary diagnosis, then up to three more.
const MAX_LINE_DIAGNOSIS_POINTERS = 4;

// Normalize stored ICD-10 codes for the wire: uppercase, strip everything but
// A-Z/0-9 (so 'f32.9' and 'F32 9' both land on 'F329'), drop blanks, and
// de-duplicate while preserving the clinician's stored order. Same rule as
// normalize() in public/app/diagnosis-codes.js, restated here rather than
// imported because the Lambda bundle ships backend/ only.
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

// Service-line procedure-modifier cardinality. The 837P professional service
// (SV101) carries up to FOUR modifiers (SV101-3..SV101-6), mirroring CMS-1500
// Box 24D. Backend validation (handlers/sessions.js) already enforces this, but
// the builder re-caps defensively for direct adapter callers.
const MAX_LINE_PROCEDURE_MODIFIERS = 4;

// Normalize stored procedure modifiers for the wire: trim, uppercase, keep only
// codes that are exactly two alphanumeric characters, de-duplicate while preserving
// stored order, and cap at four. This is the ACCEPTED shape of parseProcedureModifiers()
// in backend/handlers/sessions.js — restated here rather than imported because the
// Lambda bundle ships backend/ only. The handler is the strict gatekeeper (a malformed
// code makes it reject the whole write with a 400); the builder is defensive and simply
// drops anything malformed rather than failing a submission, so what it emits is always
// a subset of what the handler would have persisted. A non-array (or all-blank) input
// yields [] so the caller omits the field entirely.
function normalizeProcedureModifiers(mods) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(mods) ? mods : []) {
    const code = String(raw == null ? '' : raw).trim().toUpperCase();
    if (!/^[A-Z0-9]{2}$/.test(code) || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
    if (out.length >= MAX_LINE_PROCEDURE_MODIFIERS) break;
  }
  return out;
}

// Trim a stored text field to a non-empty string, else ''. Used for the optional
// fields that must be ABSENT (not '' / null) from the built body when unset.
function cleanStr(v) {
  return v == null ? '' : String(v).trim();
}

// Parse a finite number out of an adjudication field, else null.
function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 837P control numbers (CLM01 patient control number, REF*6R line item control
// number) are capped at 20 characters; a longer value makes Stedi reject the claim
// (error 33). Strip to alphanumerics (payers mishandle special characters) and cap
// at 20 as a defensive backstop — the handler already mints a <=17-char value.
const MAX_CONTROL_NUMBER_LEN = 20;
function boundControlNumber(v) {
  return String(v == null ? '' : v).replace(/[^A-Za-z0-9]/g, '').slice(0, MAX_CONTROL_NUMBER_LEN);
}

// The patient control number to send. Prefer the value the claim carries (minted
// and persisted by the claims handler so it stays stable across resubmissions and
// matches 277/835 responses). Fall back to a short, deterministic id derived from
// the claim UUID so a direct adapter call never sends the raw 36-char UUID.
function patientControlNumber(claim) {
  const stored = boundControlNumber(claim && claim.patient_control_number);
  if (stored) return stored;
  return boundControlNumber(claim && claim.id).slice(0, 17) || 'CLAIM';
}

// Resolve the 837P billing- and rendering-provider loops from the rendering
// clinician's stored billing profile. No hardcoded entity type — the profile
// decides, which is what makes submitting an individual (Type-1) NPI as an
// organizational billing provider structurally impossible:
//
//   person             → billing provider = the individual (legal name + NPI +
//                        billing TIN); NO rendering provider.
//   non_person_entity  → billing provider = the practice organization
//                        (name + NPI + EIN); rendering provider = the individual.
//   (no profile yet)   → legacy fallback: organizational billing from the
//                        practice (billing NPI = practice.npi || clinician.npi),
//                        so pre-billing-profile providers keep working unchanged.
//
// Pure. Returns { billing, rendering|null, billingNpi }.
function buildProviderLoops(ctx) {
  const clinician = (ctx && ctx.clinician) || {};
  const practice = (ctx && ctx.practice) || {};
  const profile = (ctx && ctx.billingProfile) || null;
  const address = {
    address1: practice.address_line1 || undefined,
    address2: practice.address_line2 || undefined,
    city: practice.city || undefined,
    state: practice.state || undefined,
    postalCode: practice.postal_code || undefined,
  };

  if (profile && profile.billing_entity_type === 'person') {
    const npi = profile.individual_npi || clinician.npi || null;
    const billing = {
      providerType: 'BillingProvider',
      npi: npi || undefined,
      firstName: profile.legal_first_name || clinician.first_name || undefined,
      lastName: profile.legal_last_name || clinician.last_name || undefined,
      address,
    };
    // Person tax id: EIN → employerId, SSN → ssn (mutually exclusive), digits
    // only. NOTE: confirm the person-provider tax-id field names against a Stedi
    // test account before going live (see the file-header disclaimer). ctx carries
    // billing_tin already decrypted by buildClaimContext.
    const tinDigits = profile.billing_tin ? digitsOnly(profile.billing_tin) : null;
    if (tinDigits) {
      if (profile.billing_tin_type === 'SSN') billing.ssn = tinDigits;
      else billing.employerId = tinDigits;
    }
    return { billing, rendering: null, billingNpi: npi };
  }

  if (profile && profile.billing_entity_type === 'non_person_entity') {
    const orgNpi = practice.npi || null;
    const billing = {
      providerType: 'BillingProvider',
      npi: orgNpi || undefined,
      employerId: practice.tax_id || undefined,
      organizationName: practice.name || undefined,
      address,
    };
    const rendering = {
      providerType: 'RenderingProvider',
      npi: profile.individual_npi || clinician.npi || undefined,
      firstName: profile.legal_first_name || clinician.first_name || undefined,
      lastName: profile.legal_last_name || clinician.last_name || undefined,
    };
    return { billing, rendering, billingNpi: orgNpi };
  }

  // Legacy fallback: no billing profile stored yet for this clinician.
  const billingNpi = practice.npi || clinician.npi || null;
  const billing = {
    providerType: 'BillingProvider',
    npi: billingNpi || undefined,
    employerId: practice.tax_id || undefined,
    organizationName: practice.name || undefined,
    address,
  };
  return { billing, rendering: null, billingNpi };
}

// -----------------------------------------------------------------------------
// Claim frequency (837P CLM05-3 / CMS-1500 Box 22) — '1' original, '7' replacement.
//
// A replacement claim asks the payer to REPLACE a claim it previously accepted.
// It MUST carry the payer's ORIGINAL claim control number so the payer replaces
// that specific claim; the clearinghouse translates it to the claim-level REF*F8
// segment. Omitting it (or sending frequency 7 as a new original) makes the payer
// treat the resubmission as a DUPLICATE and reject it.
//
// The frequency is read from the claim's DURABLE submission_frequency_code
// (persisted by the submit handler / the /replace flow, not transient request
// input). Anything other than '7' is an original '1'. Void (frequency 8) is a
// separate, later capability and is intentionally NOT produced here.
// -----------------------------------------------------------------------------
const CLAIM_FREQUENCY_ORIGINAL = '1';
const CLAIM_FREQUENCY_REPLACEMENT = '7';

// Replacement intent is read from the durable frequency code OR a reference to the
// claim being replaced. Keying on BOTH (not just the code) means a row that carries
// corrects_claim_id can never slip through the builder as a new original '1' — it
// is built as frequency 7 and REQUIRES the payer claim number (throwing if absent),
// exactly matching the submit handler's gate so the two can never disagree.
function isReplacementClaim(claim) {
  return String((claim && claim.submission_frequency_code) || '').trim() === CLAIM_FREQUENCY_REPLACEMENT ||
    (claim != null && claim.corrects_claim_id != null);
}

// The payer's original claim control number to send on a replacement (REF*F8 /
// claimControlNumber). Trim only — payer-assigned ICN/DCN values vary in format and
// length across payers, and REF02 tolerates up to 50 chars, so we do NOT strip
// characters or truncate the way the 20-char CLM01 patient control number is bounded.
function replacementReferenceNumber(claim) {
  return cleanStr(claim && claim.payer_claim_control_number);
}

// Build the 837P submission request body from the claim context. Pure (no network)
// so it can be unit-tested; submitClaim() POSTs whatever this returns.
function buildSubmissionBody(ctx) {
  const claim = (ctx && ctx.claim) || {};
  const insurance = (ctx && ctx.insurance) || {};
  const client = (ctx && ctx.client) || {};
  const clinician = (ctx && ctx.clinician) || {};
  const practice = (ctx && ctx.practice) || {};
  const session = (ctx && ctx.session) || {};

  const tradingPartnerServiceId = insurance.payer_id;
  if (!tradingPartnerServiceId) {
    throw new Error('Stedi submit requires insurance.payer_id (tradingPartnerServiceId).');
  }

  const { billing, rendering, billingNpi } = buildProviderLoops(ctx);

  // Diagnoses (Box 21). Normalize what the session stored, then enforce the
  // CLAIM-level limit. Over the limit we refuse to build rather than quietly
  // truncating: silently dropping a diagnosis means the clinician never learns it
  // failed to reach the payer. The service line has its own, smaller limit below.
  const diagnoses = normalizeDiagnosisCodes(session.diagnosis_codes);
  if (diagnoses.length > MAX_CLAIM_DIAGNOSES) {
    throw new Error(
      `Claim carries ${diagnoses.length} diagnoses but the 837P allows at most ` +
      `${MAX_CLAIM_DIAGNOSES}. Reduce the diagnosis list on the session before submitting.`
    );
  }

  const claimInformation = {
    claimFilingCode: 'CI',           // commercial / OON default
    claimFrequencyCode: '1',         // original claim
    // Place of service (Box 24B/32) — the session decides. 11 = office,
    // 10 = telehealth in the patient's home, 02 = telehealth elsewhere.
    // Falls back to office when the session carries nothing.
    placeOfServiceCode: cleanStr(session.place_of_service) || '11',
    claimChargeAmount: claim.billed_amount != null ? String(claim.billed_amount) : undefined,
    patientControlNumber: patientControlNumber(claim), // <=20 chars; echoed in 277CA / 835 ERA for reconciliation
    benefitsAssignmentCertificationIndicator: 'N',
    releaseInformationCode: 'Y',
    signatureIndicator: 'Y',         // provider signature on file
    planParticipationCode: 'C',      // not assigned — OON: payer reimburses the client directly
    // Diagnoses — required by Stedi. The first stored code is the principal (ABK),
    // every later one is secondary (ABF). When the session has no usable code at
    // all, fall back to a placeholder so the adapter doesn't hard-fail on missing
    // data (F329 = unspecified depressive episode).
    healthCareCodeInformation: diagnoses.length
      ? diagnoses.map((code, i) => ({
        diagnosisTypeCode: i === 0 ? 'ABK' : 'ABF',
        diagnosisCode: code,
      }))
      : [{ diagnosisTypeCode: 'ABK', diagnosisCode: 'F329' }],
  };

  // Only attach a service line when we have a CPT code; otherwise omit serviceLines.
  // Note: no line-item control number (REF*6R) is sent — nothing here is UUID-based,
  // so there is no >20-char value to bound. If one is ever added, route it through
  // boundControlNumber() so it stays within the 20-char limit like the CLM01 above.
  if (session.cpt_code) {
    const pointerCount = Math.min(
      Math.max(diagnoses.length, 1),
      MAX_LINE_DIAGNOSIS_POINTERS
    );
    const lineDiagnosisPointers = Array.from({ length: pointerCount }, (_, i) => String(i + 1));
    const professionalService = {
      procedureIdentifier: 'HC',
      procedureCode: session.cpt_code,
      lineItemChargeAmount: claim.billed_amount != null ? String(claim.billed_amount) : undefined,
      measurementUnit: 'UN',     // units of service
      serviceUnitCount: '1',     // one unit per claim line (standard for OON psychotherapy CPT codes)
      // Point this line at the first N diagnoses declared above, in stored
      // order, 1-indexed. N is capped by the LINE limit (4), which is smaller
      // than the claim limit (12) — emitting one pointer per claim diagnosis
      // would overflow SV107. With no stored diagnoses this is ['1'], the
      // placeholder principal.
      compositeDiagnosisCodePointers: { diagnosisCodePointers: lineDiagnosisPointers },
    };

    // Procedure modifiers (Box 24D / SV101-3..6) — e.g. 95 for synchronous
    // telehealth, paired with the telehealth place of service above. The session
    // decides; omit the field ENTIRELY when there are none (never '' / null / []).
    // procedureModifiers is an array of strings on professionalService, confirmed
    // against Stedi's live schema via the negative-control probe (see the PR).
    const procedureModifiers = normalizeProcedureModifiers(session.procedure_modifiers);
    if (procedureModifiers.length) {
      professionalService.procedureModifiers = procedureModifiers;
    }

    claimInformation.serviceLines = [
      {
        serviceDate: ymd(session.session_date) || undefined,
        professionalService,
      },
    ];
  }

  // Replacement claim (CMS frequency 7): override the default original ('1') and
  // attach the payer's ORIGINAL claim control number so the payer REPLACES that
  // claim instead of rejecting this as a duplicate original. The reference goes on
  // the child key claimControlNumber inside claimInformation.claimSupplementalInformation
  // (claimSupplementalInformation is a confirmed-valid object; the child key name
  // MUST be confirmed against Stedi's live schema via the negative-control probe —
  // a silently-wrong name here sends the replacement out as a duplicate original).
  // The clearinghouse translates this to the claim-level REF*F8 segment.
  //
  // We REFUSE to build a frequency-7 body without the reference rather than quietly
  // falling back to '1' — the submit handler's safety gate rejects this case first
  // with a clean error, but the builder is the last line of defense for any direct
  // adapter caller. Ordinary claims never enter this branch, so their body stays
  // byte-identical (claimFrequencyCode '1', no claimSupplementalInformation).
  if (isReplacementClaim(claim)) {
    const payerRef = replacementReferenceNumber(claim);
    if (!payerRef) {
      throw new Error(
        'Replacement claim (frequency 7) requires the payer claim control number ' +
        '(claimInformation.claimSupplementalInformation.claimControlNumber). Refusing to ' +
        'send as a new original, which the payer would reject as a duplicate.'
      );
    }
    claimInformation.claimFrequencyCode = CLAIM_FREQUENCY_REPLACEMENT;
    claimInformation.claimSupplementalInformation = {
      ...(claimInformation.claimSupplementalInformation || {}),
      claimControlNumber: payerRef,
    };
  }

  // Prior authorization number (CMS-1500 Box 23 / 837P claim-level REF*G1). This
  // is CLAIM-LEVEL — specific to a course of treatment / date range / provider —
  // NOT a property of the policy, so it is read from the claim, never the
  // insurance record. Merge into claimSupplementalInformation the same merge-safe
  // way the replacement block above does, so a replacement claim that ALSO carries
  // a prior auth keeps BOTH keys (claimControlNumber + priorAuthorizationNumber).
  // Omitted ENTIRELY when the claim carries none, so ordinary claims stay
  // structurally unchanged (no claimSupplementalInformation at all). The child key
  // name priorAuthorizationNumber MUST be confirmed against Stedi's live schema via
  // the negative-control probe (see the PR) — a silently-wrong name drops the auth.
  const priorAuth = cleanStr(claim.prior_authorization_number);
  if (priorAuth) {
    claimInformation.claimSupplementalInformation = {
      ...(claimInformation.claimSupplementalInformation || {}),
      priorAuthorizationNumber: priorAuth,
    };
  }

  // Dependent mode: when the insurance record names a subscriber relationship
  // other than 'self', the patient is a dependent on someone else's policy. The
  // 837P then wants the POLICYHOLDER in the subscriber loop and the PATIENT in a
  // singular `dependent` object (note: singular here, unlike eligibility's
  // `dependents` array). Putting the patient in the subscriber loop for a
  // dependent is what got a live claim rejected with 277CA A3/21 "invalid
  // patient/subscriber information"; Stedi now also validates the pairing at
  // submission and returns error 33 on a mismatch, so a wrong shape fails fast.
  const rel = insurance.subscriber_relationship;
  const isDependent =
    rel != null && String(rel).trim() !== '' && String(rel).trim().toLowerCase() !== 'self';

  let subscriber;
  let dependent = null;
  if (isDependent) {
    // Policyholder in the subscriber loop. We build by adding present fields only
    // (no empty strings leak in): the policyholder name (split on the last space),
    // DOB, and — for payers that require them on a dependent claim — the
    // policyholder's gender (Box 11a) and address (Box 7), each captured on the
    // insurance record.
    subscriber = { paymentResponsibilityLevelCode: 'P' };
    if (insurance.member_id) subscriber.memberId = insurance.member_id;
    const [subFirst, subLast] = splitSubscriberName(insurance.subscriber_name);
    if (subFirst) subscriber.firstName = subFirst;
    if (subLast) subscriber.lastName = subLast;
    const subDob = ymd(insurance.subscriber_dob);
    if (subDob) subscriber.dateOfBirth = subDob;

    // Policyholder gender (Box 11a). Map the stored female|male|unknown vocabulary
    // through the SAME genderCode() helper the non-dependent subscriber branch uses
    // (female→F, male→M, unknown→U). Present only when the record carries a gender:
    // an explicit 'unknown' is sent as 'U' exactly as the non-dependent path emits
    // it, but an UNSET gender omits the key entirely (never '' / null), so an
    // ordinary dependent claim without demographics stays structurally unchanged.
    if (insurance.subscriber_gender) {
      subscriber.gender = genderCode(insurance.subscriber_gender);
    }

    // Policyholder address (Box 7). Build from present fields only and attach the
    // address object ENTIRELY only when at least one line is present, so a
    // dependent claim with no policyholder address omits the key rather than
    // sending an all-undefined object. Field names mirror the non-dependent
    // subscriber block (address1/address2/city/state/postalCode).
    const subAddress = {};
    if (insurance.subscriber_address_line1) subAddress.address1 = insurance.subscriber_address_line1;
    if (insurance.subscriber_address_line2) subAddress.address2 = insurance.subscriber_address_line2;
    if (insurance.subscriber_city) subAddress.city = insurance.subscriber_city;
    if (insurance.subscriber_state) subAddress.state = insurance.subscriber_state;
    if (insurance.subscriber_postal_code) subAddress.postalCode = insurance.subscriber_postal_code;
    if (Object.keys(subAddress).length) subscriber.address = subAddress;

    // Patient in the dependent loop: the same client sources as the subscriber
    // block below, plus the relationship code. Gender is omitted when unknown (U).
    dependent = {
      relationshipToSubscriberCode: relationshipToSubscriberCode(rel),
    };
    if (client.first_name) dependent.firstName = client.first_name;
    if (client.last_name) dependent.lastName = client.last_name;
    const depDob = ymd(client.date_of_birth);
    if (depDob) dependent.dateOfBirth = depDob;
    const depGender = genderCode(client.gender);
    if (depGender !== 'U') dependent.gender = depGender;
    dependent.address = {
      address1: client.address_line1 || undefined,
      address2: client.address_line2 || undefined,
      city: client.city || undefined,
      state: client.state || undefined,
      postalCode: client.postal_code || undefined,
    };
  } else {
    // Non-dependent (patient IS the subscriber): unchanged from the original shape.
    // Stedi auto-sets relationship code 18 (self) and no dependent loop is sent.
    subscriber = {
      paymentResponsibilityLevelCode: 'P',        // primary payer
      memberId: insurance.member_id || undefined,
      firstName: client.first_name || undefined,
      lastName: client.last_name || undefined,
      dateOfBirth: ymd(client.date_of_birth) || undefined,
      gender: genderCode(client.gender),          // 837 requires demographics when patient is subscriber
      address: {
        address1: client.address_line1 || undefined,
        address2: client.address_line2 || undefined,
        city: client.city || undefined,
        state: client.state || undefined,
        postalCode: client.postal_code || undefined,
      },
    };
  }

  // Group number (Box 11 / SBR03) — the employer/plan group id, on the PRIMARY
  // subscriber loop in both shapes above. Deliberately NOT on
  // otherSubscriberInformation: that loop describes the OTHER payer in a
  // coordination-of-benefits claim, which is a different thing. Omitted entirely
  // when the insurance record carries no group number.
  const groupNumber = cleanStr(insurance.group_number);
  if (groupNumber) subscriber.groupNumber = groupNumber;

  const body = {
    tradingPartnerServiceId,
    // Test vs production. Always explicit — never left to Stedi's default. See
    // resolveUsageIndicator: 'P' unless an operator-controlled gate says otherwise.
    usageIndicator: resolveUsageIndicator(ctx),
    submitter: {
      organizationName: practice.name || undefined,
      contactInformation: {
        name: practice.name || undefined,
        email: SUBMITTER_CONTACT_EMAIL,
      },
    },
    receiver: {
      // Stedi matches the payer on tradingPartnerServiceId; the receiver name
      // just needs to be non-empty. Records created through the payer typeahead
      // persist a payer_id but not always a carrier_name, so fall back to the
      // trading-partner id rather than sending an undefined organizationName
      // (which Stedi rejects with 400 "Receiver: missing field organizationName").
      organizationName: insurance.carrier_name || tradingPartnerServiceId,
    },
    // Billing provider loop — sourced from the clinician's billing profile
    // (person vs organization), NOT a hardcoded entity type. See buildProviderLoops.
    billing,
    subscriber,
    claimInformation,
  };

  // Rendering provider loop — present only when billing as an organization
  // (non_person_entity), naming the individual who performed the service.
  if (rendering) body.rendering = rendering;

  // Only present in dependent mode; omitted entirely otherwise so the
  // non-dependent body stays byte-identical to the original.
  if (dependent) body.dependent = dependent;

  return { body, tradingPartnerServiceId, billingNpi };
}

// Pull a human-readable rejection out of a Stedi submission error body so the
// handler can surface it (e.g. error 33 "Invalid Patient Control Number ...").
// Tolerates the shapes Stedi returns — an `errors` array of { code, message /
// description / field }, a single `error` object, or an RFC7807 { title, detail }.
// Returns { code, description } or null when nothing surfaceable is present.
function parseSubmissionRejection(data) {
  if (!data || typeof data !== 'object') return null;

  const arr = Array.isArray(data.errors) ? data.errors
    : Array.isArray(data.fieldErrors) ? data.fieldErrors
      : data.error && typeof data.error === 'object' ? [data.error]
        : null;

  if (arr && arr.length) {
    const describe = (e) => {
      if (e == null) return null;
      if (typeof e === 'string') return e;
      const code = e.code != null ? e.code : e.errorCode;
      const msg = e.message || e.description || e.detail || e.error || e.title || e.field;
      if (msg == null && code == null) return null;
      return code != null ? `[${code}] ${msg != null ? msg : ''}`.trim() : String(msg);
    };
    const parts = arr.map(describe).filter(Boolean);
    if (parts.length) {
      const firstObj = arr.find((e) => e && typeof e === 'object') || {};
      const code = firstObj.code != null ? String(firstObj.code)
        : firstObj.errorCode != null ? String(firstObj.errorCode) : null;
      return { code, description: parts.join('; ') };
    }
  }

  const single = data.detail || data.title || (typeof data.error === 'string' ? data.error : data.message);
  if (single) {
    return { code: data.code != null ? String(data.code) : null, description: String(single) };
  }
  return null;
}

async function submitClaim(ctx) {
  const claim = (ctx && ctx.claim) || {};
  const { body, tradingPartnerServiceId, billingNpi } = buildSubmissionBody(ctx);

  const res = await stediPost('/professionalclaims/v3/submission', body, {
    'Idempotency-Key': String(claim.id || ''),
  });

  const data = await res.json().catch(() => ({}));

  // Stedi returns the control number on claimReference.correlationId or controlNumber.
  const ref = (data && data.claimReference) || {};
  const control = ref.correlationId || data.controlNumber || ref.controlNumber || null;

  if (!res.ok || !control) {
    // A structured payer/validation rejection (error 33, etc.) carries a reason we
    // want the user to see: throw a flagged error the handler turns into a 422.
    const rejection = parseSubmissionRejection(data);
    if (rejection) {
      const e = new Error(rejection.description);
      e.isRejection = true;
      e.rejection = rejection;
      throw e;
    }
    // Otherwise fail generically — never include the response body, which can
    // echo submitted PHI (member id, name, DOB).
    throw new Error(`Stedi submission failed (HTTP ${res.status})`);
  }

  return {
    control_number: String(control),
    claim_number: claim.claim_number || String(control),
    status: 'submitted',
    // Persisted to claims.clearinghouse_payload — getStatus() reads these back.
    raw: {
      adapter: name,
      tradingPartnerServiceId,
      billing_npi: billingNpi,
      response: data,
    },
  };
}

// Build the real-time claim-status (276/277) request body from the claim context.
// Pure (no network) so it can be unit-tested; getStatus() POSTs whatever this
// returns. Stedi recommends a MINIMAL base request — over-specifying degrades
// matching — so we send only tradingPartnerServiceId, the encounter dates, the
// billing provider, and the subscriber.
//
// Sourcing mirrors buildSubmissionBody exactly, because the 276 must describe the
// same parties as the 837 that was filed:
//   * tradingPartnerServiceId — the payer id used at submission. Prefer the value
//     persisted on the claim at submit time (clearinghouse_payload), then the
//     insurance record's payer_id.
//   * providers[BillingProvider] — the practice (organizationName + NPI), same
//     billing loop the 837 used (persisted billing_npi, else practice/clinician).
//   * subscriber — the POLICYHOLDER, who is NOT necessarily the patient. On a
//     dependent claim the policyholder is on the insurance record; when the patient
//     IS the subscriber ('self' / no relationship) the patient (client) is used.
//     No dependent block is sent — the base request matches on the subscriber.
// Any required field that is missing throws a descriptive error naming the field.
function buildStatusBody(ctx) {
  const claim = (ctx && ctx.claim) || {};
  const insurance = (ctx && ctx.insurance) || {};
  const client = (ctx && ctx.client) || {};
  const clinician = (ctx && ctx.clinician) || {};
  const practice = (ctx && ctx.practice) || {};
  const session = (ctx && ctx.session) || {};
  const payload = claim.clearinghouse_payload || {};

  const tradingPartnerServiceId = payload.tradingPartnerServiceId || insurance.payer_id;
  if (!tradingPartnerServiceId) {
    throw new Error('Stedi status check requires tradingPartnerServiceId (payer id used at submission).');
  }

  // The 276 must name the same billing provider the 837 filed. Source it from
  // the billing profile (person vs organization); prefer the billing npi
  // persisted at submit time (clearinghouse_payload) so a later profile edit
  // can't change what we query on.
  const loops = buildProviderLoops(ctx);
  const billingNpi = payload.billing_npi || loops.billingNpi || null;
  if (!billingNpi) {
    throw new Error('Stedi status check requires the billing provider npi.');
  }
  const statusProvider = { providerType: 'BillingProvider', npi: billingNpi };
  if (loops.billing.organizationName) {
    statusProvider.organizationName = loops.billing.organizationName;
  } else {
    // Person billing provider: the 276 wants the individual's name.
    if (loops.billing.firstName) statusProvider.firstName = loops.billing.firstName;
    if (loops.billing.lastName) statusProvider.lastName = loops.billing.lastName;
    if (!statusProvider.firstName && !statusProvider.lastName) {
      throw new Error('Stedi status check requires the billing provider name.');
    }
  }

  // Payers may store a service date that differs by a day or two from ours, so we
  // query a ±7-day window around the claim's date of service rather than a single
  // day, which improves matching. The end is capped at today (a payer can't have a
  // status for a future service date, and some reject a future endDateOfService).
  const dos = ymd(session.session_date);
  if (!dos) {
    throw new Error('Stedi status check requires the session date of service.');
  }
  const beginningDateOfService = shiftYmd(dos, -7);
  let endDateOfService = shiftYmd(dos, 7);
  const today = todayYmd();
  if (endDateOfService > today) endDateOfService = today;

  const rel = insurance.subscriber_relationship;
  const isDependent =
    rel != null && String(rel).trim() !== '' && String(rel).trim().toLowerCase() !== 'self';

  const memberId = insurance.member_id;
  if (!memberId) {
    throw new Error('Stedi status check requires the subscriber memberId.');
  }

  let firstName;
  let lastName;
  let dateOfBirth;
  if (isDependent) {
    [firstName, lastName] = splitSubscriberName(insurance.subscriber_name);
    dateOfBirth = ymd(insurance.subscriber_dob);
  } else {
    firstName = client.first_name || '';
    lastName = client.last_name || '';
    dateOfBirth = ymd(client.date_of_birth);
  }
  if (!firstName) throw new Error('Stedi status check requires the subscriber firstName.');
  if (!lastName) throw new Error('Stedi status check requires the subscriber lastName.');
  if (!dateOfBirth) throw new Error('Stedi status check requires the subscriber dateOfBirth.');

  // With no dependent object Stedi treats the subscriber as the patient, and when
  // dateOfBirth is present it REQUIRES gender. Source it the same way the 837 did:
  // the patient's (client) gender when the patient is the subscriber, the
  // policyholder's persisted gender (insurance_records.subscriber_gender) on a
  // dependent claim. Map to Stedi's M/F; omit gender entirely when unknown/unmappable
  // (docs allow omitting gender when unknown) while keeping dateOfBirth.
  const gender = genderCode(isDependent ? insurance.subscriber_gender : client.gender);

  const subscriber = {
    firstName,
    lastName,
    dateOfBirth,
    memberId,
  };
  if (gender === 'M' || gender === 'F') subscriber.gender = gender;

  const encounter = {
    beginningDateOfService,
    endDateOfService,
  };
  // Several payers require the submitted charge to match a claim; send it as a
  // string decimal ("135.00") only when the claim carries a billed amount.
  const billed = num(claim.billed_amount);
  if (billed != null) encounter.submittedAmount = billed.toFixed(2);

  const body = {
    tradingPartnerServiceId,
    encounter,
    providers: [statusProvider],
    subscriber,
  };

  return { body, tradingPartnerServiceId, billingNpi };
}

// Map a 277 claimStatusCategoryCode to the Reddably claim enum. The category code
// is the authoritative lifecycle bucket (its finer statusCode is only a fallback):
//
//   F  Finalized              → paid   (F2 = Finalized/Denial → denied)
//   P  Pending                → processing
//   R  Request for more info  → info_requested
//   A1 / A2 / A5 Received/Accepted → submitted
//   A3 / A6 / A7 / A8 Rejected at acknowledgement → denied
//
// Anything else — A4 (Not Found), D0 (search unsuccessful), E (errors), unknown —
// returns null so the caller treats it as a non-fatal "no update" (the claim keeps
// its current status) rather than force-mapping it.
function mapStatusCategory(cat) {
  const c = String(cat == null ? '' : cat).trim().toUpperCase();
  if (!c) return null;
  if (c === 'F2') return 'denied';
  switch (c[0]) {
    case 'F': return 'paid';
    case 'P': return 'processing';
    case 'R': return 'info_requested';
    default: break;
  }
  if (c === 'A1' || c === 'A2' || c === 'A5') return 'submitted';
  if (c === 'A3' || c === 'A6' || c === 'A7' || c === 'A8') return 'denied';
  return null;
}

// Map a Stedi claim statusCode (numeric or descriptive) to the Reddably enum.
// Fallback only — used when a response carries a statusCode but no category code we
// recognize. Returns null for values we can't place, so the caller can treat the
// response as "no update" rather than guessing.
function mapStatus(code) {
  const c = code == null ? '' : String(code).trim().toLowerCase();
  switch (c) {
    case '1':
    case 'processed as primary':
    case '2':
    case 'processed as secondary':
    case '3':
    case 'processed as tertiary':
      return 'paid';
    case '4':
    case 'denied':
      return 'denied';
    case '19':
    case 'pending':
      return 'processing';
    default:
      return null;
  }
}

// Pull the most relevant claim-status object out of Stedi's response, tolerating a
// few shapes ({ claims: [{ claimStatus }] }, { claimStatus }, a bare claim object).
// Returns null when there is no claim-status object at all — a no-match 200 carries
// an empty (or absent) claims array, and returning `data` itself here would make
// that no-match look like a real status. The caller reads null as "no update".
function firstStatus(data) {
  if (!data || typeof data !== 'object') return null;
  const claims = Array.isArray(data.claims) ? data.claims : (data.claim ? [data.claim] : null);
  if (Array.isArray(claims) && claims.length) {
    const last = claims[claims.length - 1];
    return last.claimStatus || last.status || last;
  }
  if (data.claimStatus && typeof data.claimStatus === 'object') return data.claimStatus;
  if (data.status && typeof data.status === 'object') return data.status;
  return null;
}

// Pull ONLY the structural hint attributes from a Stedi error body — the error
// code and the offending field/location/path that name WHICH field was wrong.
// Never the field values, messages, or any PHI (names/DOB/member id), which the
// human-readable message text can echo. Returns compact "code=.. field=.." strings.
function statusErrorHints(data) {
  if (!data || typeof data !== 'object') return [];
  const arr = Array.isArray(data.errors) ? data.errors
    : Array.isArray(data.fieldErrors) ? data.fieldErrors
      : (data.error && typeof data.error === 'object') ? [data.error]
        : (data.code != null || data.field != null || data.location != null || data.path != null) ? [data]
          : [];
  const out = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const parts = [];
    if (e.code != null) parts.push(`code=${String(e.code)}`);
    if (e.field != null) parts.push(`field=${String(e.field)}`);
    if (e.location != null) parts.push(`location=${String(e.location)}`);
    if (e.path != null) parts.push(`path=${String(e.path)}`);
    if (parts.length) out.push(parts.join(' '));
  }
  return out.slice(0, 5);
}

async function getStatus({ control_number, claim, ctx }) {
  // Prefer the assembled context (subscriber / provider / DOS) the handler passes
  // so the 276 mirrors the 837 that was filed; fall back to a claim-only ctx for
  // direct callers. buildStatusBody throws (naming the field) on missing data.
  const { body } = buildStatusBody(ctx || { claim });

  const res = await stediPost('/claimstatus/v2', body);

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // On a 4xx, Stedi names the offending field(s) in the error body; log ONLY the
    // structural attributes (error code, field/location) to aid debugging — never
    // field values or the message text, which can carry PHI (member id, name, DOB).
    if (res.status >= 400 && res.status < 500) {
      const hints = statusErrorHints(data);
      if (hints.length) {
        console.error(`Stedi status check ${res.status} fields: ${hints.join('; ')}`);
      }
    }
    // Never echo the response body — it can carry PHI (member id, name, DOB).
    throw new Error(`Stedi status check failed (HTTP ${res.status})`);
  }

  // Status is derived from the response body, NEVER the HTTP status: a no-match
  // comes back HTTP 200. When no claim-status object is present, or its category
  // is one we don't map (Not Found, etc.), report a non-fatal "no update" so the
  // claim keeps its current status.
  const info = firstStatus(data);
  if (!info) return { no_update: true, raw: data };

  const category =
    info.claimStatusCategoryCode != null ? info.claimStatusCategoryCode
      : info.statusCategoryCode != null ? info.statusCategoryCode
        : null;
  const statusCode =
    info.statusCode != null ? info.statusCode
      : info.claimStatusCode != null ? info.claimStatusCode
        : info.code != null ? info.code
          : null;

  let status = mapStatusCategory(category);
  if (status == null && statusCode != null) status = mapStatus(statusCode);
  if (status == null) return { no_update: true, raw: data };

  // Adjudication amounts live under a few possible keys; absent → null.
  const adj = info.adjudication || info.monetaryAmounts || info;
  const allowed = num(adj.allowedAmount);
  const reimbursed = num(adj.paidAmount != null ? adj.paidAmount : adj.reimbursedAmount);
  const patientResp = num(adj.patientResponsibilityAmount);

  const denialReason =
    status === 'denied'
      ? info.statusCategoryCodeValue || info.claimStatusCategoryCodeValue || info.description || null
      : null;

  return {
    status,
    denial_reason: denialReason,
    allowed_amount: allowed,
    reimbursed_amount: reimbursed,
    patient_responsibility: patientResp,
    raw: data,
  };
}

// -----------------------------------------------------------------------------
// Eligibility / VOB (270/271) — real-time benefit check. Powers the Instant VOB
// add-on (handlers/vob.js). Same base + raw-key auth as submitClaim; the endpoint
// is {base}/eligibility/v3. Returns Stedi's parsed 271 response verbatim; the
// handler normalizes it for the UI and keeps the full payload as `raw`.
// -----------------------------------------------------------------------------
async function checkEligibility(params) {
  const p = params || {};

  const tradingPartnerServiceId = p.payerId;
  if (!tradingPartnerServiceId) {
    throw new Error('Stedi eligibility requires payerId (tradingPartnerServiceId).');
  }

  // Provider: Stedi requires an organizationName or a first/last name, plus the NPI.
  const provider = {};
  if (p.organizationName) provider.organizationName = p.organizationName;
  if (p.npi) provider.npi = p.npi;

  // Dependent mode: when the patient is a dependent on someone else's policy (no
  // unique member id of their own), the subscriber loop carries the POLICYHOLDER
  // (memberId + policyholder demographics when known) and the patient goes in a
  // `dependents` array. Many payers error without the dependent's DOB, so include
  // it. When p.dependent is absent (or has no non-empty field) the request is
  // built exactly as before: patient demographics in the subscriber loop.
  const dep = p.dependent || null;
  const depHasValue = !!dep && [dep.firstName, dep.lastName, dep.dateOfBirth]
    .some((v) => v != null && String(v).trim() !== '');

  const subscriber = { memberId: p.memberId || undefined };
  if (p.firstName) subscriber.firstName = p.firstName;
  if (p.lastName) subscriber.lastName = p.lastName;
  if (ymd(p.dateOfBirth)) subscriber.dateOfBirth = ymd(p.dateOfBirth);

  const body = {
    tradingPartnerServiceId,
    provider,
    subscriber,
    // Service type 30 = Health Benefit Plan Coverage (general benefits) by default.
    encounter: {
      serviceTypeCodes: [p.serviceType ? String(p.serviceType) : '30'],
    },
  };

  if (depHasValue) {
    const dependent = {};
    if (dep.firstName) dependent.firstName = dep.firstName;
    if (dep.lastName) dependent.lastName = dep.lastName;
    if (ymd(dep.dateOfBirth)) dependent.dateOfBirth = ymd(dep.dateOfBirth);
    body.dependents = [dependent];
  }

  const res = await stediPost('/eligibility/v3', body);

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Stedi eligibility failed (HTTP ${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

// -----------------------------------------------------------------------------
// Payer search — type-ahead lookup against Stedi's payer directory. Powers the
// payer picker in the Verify Benefits / insurance forms (handlers/payers.js).
// This endpoint lives at the healthcare API root, NOT under the medical-network
// base, so it carries its own URL. No PHI: the only input is a free-text payer
// name fragment and the response is public payer-directory data.
// -----------------------------------------------------------------------------
const SEARCH_URL =
  process.env.STEDI_SEARCH_URL ||
  'https://healthcare.us.stedi.com/2024-04-01/payers/search';

async function searchPayers(query) {
  const q = query == null ? '' : String(query);
  const url =
    `${SEARCH_URL}?query=${encodeURIComponent(q)}` +
    '&eligibilityCheck=SUPPORTED&pageSize=10';

  const res = await stediGet(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // No PHI in a payer-name search; keep the message terse regardless.
    throw new Error(`Stedi payer search failed (HTTP ${res.status})`);
  }

  const items = Array.isArray(data && data.items) ? data.items : [];
  return items
    .map((it) => {
      // Stedi wraps each hit as { score, payer: {...} }; tolerate a flat shape too.
      const p = (it && it.payer) || it || {};
      return {
        name: p.displayName || null,
        payer_id: p.primaryPayerId || null,
        stedi_id: p.stediId || null,
      };
    })
    .filter((p) => p.payer_id);
}

// -----------------------------------------------------------------------------
// ERA enrollment (Enrollments API) — per-practice payer enrollment for electronic
// remittance. Powers handlers/payer_enrollments.js. This API lives on its OWN host
// (not the medical-network base), but authenticates with the same raw STEDI_API_KEY.
//
//   base : https://enrollments.us.stedi.com/2024-09-01
//   auth : Authorization: <STEDI_API_KEY>
//
// No PHI ever crosses these calls — the payloads are practice/payer trading-partner
// data (name, NPI, tax id, business contact, payer id), so on failure we still keep
// error messages terse and never echo the request/response body.
// -----------------------------------------------------------------------------
const ENROLLMENTS_BASE =
  process.env.STEDI_ENROLLMENTS_BASE_URL ||
  'https://enrollments.us.stedi.com/2024-09-01';

// Shared transport for the enrollments API: any method, JSON body when present,
// optional query object, same 15s AbortController bound as the other calls. The
// path/URL is never echoed in the timeout error (defensive, matches the others).
async function enrollmentsFetch(method, path, body, query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STEDI_TIMEOUT_MS);
  let url = `${ENROLLMENTS_BASE}${path}`;
  if (query) {
    const qs = Object.keys(query)
      .filter((k) => query[k] != null && query[k] !== '')
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
      .join('&');
    if (qs) url += `?${qs}`;
  }
  try {
    const opts = {
      method,
      headers: { Authorization: apiKey(), Accept: 'application/json' },
      signal: controller.signal,
    };
    if (body != null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return await fetch(url, opts);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`Stedi enrollments request to ${path} timed out after ${STEDI_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Tax ids must be digits only (no dashes) on the enrollments API.
function digitsOnly(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}

// Build the enrollments contact block from a normalized contact object. Only
// present fields are sent (no empty strings), matching the rest of the adapter.
function enrollmentContact(contact) {
  const c = contact || {};
  const out = {};
  if (c.firstName) out.firstName = c.firstName;
  if (c.lastName) out.lastName = c.lastName;
  if (c.email) out.email = c.email;
  if (c.phone) out.phone = c.phone;
  if (c.streetAddress1) out.streetAddress1 = c.streetAddress1;
  if (c.city) out.city = c.city;
  if (c.state) out.state = c.state;
  if (c.zipCode) out.zipCode = c.zipCode;
  return out;
}

// ensureEnrollmentProvider(practice, contact) -> providerId.
// A provider must exist (one per practice TIN) before any enrollment. When the
// practice already carries a stedi_provider_id, reuse it (no network). Otherwise
// POST /providers and return the new id for the caller to persist. NPI + taxId
// pairs are unique on Stedi's side, so a re-create for the same pair 409s — the
// caller persists the id the first time so this stays a one-time cost.
async function ensureEnrollmentProvider(practice, contact) {
  const p = practice || {};
  if (p.stedi_provider_id) return p.stedi_provider_id;

  const body = {
    name: p.name || undefined,
    npi: p.npi || undefined,
    taxIdType: 'EIN',
    taxId: digitsOnly(p.tax_id),
    contacts: [enrollmentContact(contact)],
  };

  const res = await enrollmentsFetch('POST', '/providers', body);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data || !data.id) {
    throw new Error(`Stedi provider creation failed (HTTP ${res.status})`);
  }
  return data.id;
}

// createPayerEnrollment({ providerId, payerIdOrAlias, contact, userEmail })
//   -> { id, status }. Submits an ERA (claimPayment) enrollment immediately with
// status STEDI_ACTION_REQUIRED (DRAFT would be "not yet submitted" — unused in v1).
async function createPayerEnrollment({ providerId, payerIdOrAlias, contact, userEmail }) {
  const body = {
    transactions: { claimPayment: { enroll: true } },
    primaryContact: enrollmentContact(contact),
    userEmail: userEmail || undefined,
    payer: { idOrAlias: String(payerIdOrAlias == null ? '' : payerIdOrAlias) },
    provider: { id: providerId },
    status: 'STEDI_ACTION_REQUIRED',
  };

  const res = await enrollmentsFetch('POST', '/enrollments', body);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data || !data.id) {
    throw new Error(`Stedi enrollment creation failed (HTTP ${res.status})`);
  }
  return { id: data.id, status: data.status || 'STEDI_ACTION_REQUIRED' };
}

// getEnrollmentStatus(stediEnrollmentId) -> { status, reason }. GET a single
// enrollment; `reason` is populated when the payer/Stedi needs manual action.
async function getEnrollmentStatus(stediEnrollmentId) {
  const res = await enrollmentsFetch(
    'GET',
    `/enrollments/${encodeURIComponent(String(stediEnrollmentId))}`
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Stedi enrollment status check failed (HTTP ${res.status})`);
  }
  return { status: data.status || null, reason: data.reason || null };
}

// listEnrollments({ npi, taxId }) -> array of raw enrollment objects for the
// practice's provider, used to import enrollments created outside the app. Filters
// server-side by provider NPI + tax id when supported; the caller additionally
// de-dupes against locally-stored stedi_enrollment_ids for idempotency.
async function listEnrollments({ npi, taxId } = {}) {
  // Filters are plural array params on the List Enrollments API; a single value
  // each is accepted. providerNpis / providerTaxIds (NOT the singular forms).
  const query = {};
  if (npi) query.providerNpis = digitsOnly(npi);
  if (taxId) query.providerTaxIds = digitsOnly(taxId);

  const res = await enrollmentsFetch('GET', '/enrollments', null, query);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Stedi enrollment list failed (HTTP ${res.status})`);
  }
  if (Array.isArray(data)) return data;
  if (Array.isArray(data && data.items)) return data.items;
  return [];
}

module.exports = {
  name,
  submitClaim,
  getStatus,
  checkEligibility,
  searchPayers,
  mapStatus,
  mapStatusCategory,
  firstStatus,
  // ERA enrollment (Enrollments API).
  ensureEnrollmentProvider,
  createPayerEnrollment,
  getEnrollmentStatus,
  listEnrollments,
  // Exposed for unit testing (pure, no network).
  buildSubmissionBody,
  buildStatusBody,
  buildProviderLoops,
  parseSubmissionRejection,
  patientControlNumber,
  boundControlNumber,
  resolveUsageIndicator,
  testSubmissionsAllowed,
  isReplacementClaim,
};
