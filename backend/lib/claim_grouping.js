'use strict';

// Which draft claims may be folded into ONE 837P claim carrying several service
// lines — and, when they may not, exactly why.
//
// MONEY-PATH RULES. A grouped claim is a single filing with the payer covering
// several dates of service, and it draws a single platform fee (5% of the summed
// charge) instead of one per session. Getting the eligibility wrong does not
// produce a validation error, it produces a wrongly-filed claim: sessions billed
// under the wrong rendering provider, against the wrong policy, or with a
// diagnosis that does not belong to them.
//
// Pure: no DB, no HTTP, no logging. Every rule is a function of the claim rows
// the list endpoint already returns, so the UI can evaluate the same rules to
// decide whether to offer the action, and the server re-evaluates them
// authoritatively before writing anything.
//
// PHI: `reason` strings name FIELDS and DATES OF SERVICE, never patient names,
// member ids or diagnosis values. They are shown to authenticated practice staff
// about their own claims and must remain safe to log if a caller ever does.

// CMS-1500 Box 24 holds six service lines. The 837P itself permits more, but a
// claim that cannot be rendered onto the paper form is a claim that cannot be
// worked by a payer's back office or mailed as a corrected copy, so six is the
// practical ceiling and the one we enforce.
const MAX_GROUPED_LINES = 6;

// Fields that must be IDENTICAL across every claim in a group, because the 837P
// carries exactly one of each at the CLAIM level — not per service line. Putting
// two different values into one claim does not split it; it silently files both
// services under whichever value the builder emitted.
//
//   client_id            the patient the claim is about
//   clinician_id         the rendering provider (2310B / Box 24J)
//   insurance_record_id  the policy being billed (subscriber loop + payer)
//   place_of_service     claimInformation.placeOfServiceCode (Box 24B)
//
// Diagnoses are claim-level too, but compared as a SET rather than by equality —
// see sameDiagnoses.
const CLAIM_LEVEL_FIELDS = [
  { key: 'client_id', label: 'client' },
  { key: 'clinician_id', label: 'rendering clinician' },
  { key: 'insurance_record_id', label: 'insurance policy' },
  { key: 'place_of_service', label: 'place of service' },
];

function dateOf(claim) {
  const d = claim && claim.session_date;
  return d ? String(d).slice(0, 10) : 'an undated session';
}

// Normalize a diagnosis list for comparison: trimmed, uppercased, de-duplicated,
// sorted. Order on the session is meaningful for the 837P (the first code is the
// principal), but for deciding "are these the same diagnoses" it is not — two
// sessions carrying F411 and F321 in different orders describe the same claim.
function normalizedDiagnoses(codes) {
  if (!Array.isArray(codes)) return [];
  const seen = Object.create(null);
  const out = [];
  codes.forEach((c) => {
    if (typeof c !== 'string') return;
    const s = c.trim().toUpperCase();
    if (s === '' || seen[s]) return;
    seen[s] = true;
    out.push(s);
  });
  return out.sort();
}

function sameDiagnoses(a, b) {
  const x = normalizedDiagnoses(a);
  const y = normalizedDiagnoses(b);
  if (x.length !== y.length) return false;
  return x.every((code, i) => code === y[i]);
}

// A replacement claim (CMS frequency 7) supersedes a claim the payer already
// accepted, and carries the original's claim control number. It is a filing about
// ONE prior filing; folding other services into it would tell the payer to
// replace that claim with a different, larger one.
function isReplacement(claim) {
  return !!claim && (claim.corrects_claim_id != null || claim.submission_frequency_code === '7');
}

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Evaluate a candidate group. Returns:
//   { ok: true,  conflicts: [], total, lines }
//   { ok: false, conflicts: [{ code, message }, ...] }
//
// EVERY conflict is reported, not just the first: a user who has ticked six rows
// should be told everything wrong with the selection in one pass rather than
// discovering it one refusal at a time.
function evaluateGroup(claims) {
  const rows = Array.isArray(claims) ? claims.filter(Boolean) : [];
  const conflicts = [];
  const add = (code, message) => conflicts.push({ code, message });

  if (rows.length < 2) {
    add('too_few', 'Select at least two draft claims to group.');
    return { ok: false, conflicts };
  }
  if (rows.length > MAX_GROUPED_LINES) {
    add('too_many',
      `A claim form holds ${MAX_GROUPED_LINES} service lines; you selected ${rows.length}. ` +
      'Group them in smaller batches.');
  }

  // --- per-claim eligibility -------------------------------------------------
  rows.forEach((c) => {
    if (c.status !== 'draft') {
      add('not_draft',
        `The claim for ${dateOf(c)} is ${c.status}, not a draft. Only unsubmitted draft claims can be grouped.`);
    }
    if (isReplacement(c)) {
      add('replacement',
        `The claim for ${dateOf(c)} is a replacement of an already-filed claim and cannot be grouped.`);
    }
    // A draft that carries a control number or a submitted_at was handed to the
    // clearinghouse at some point. Grouping it would fold a service the payer may
    // already hold into a NEW original filing — a duplicate.
    if (c.control_number != null || c.submitted_at != null) {
      add('previously_transmitted',
        `The claim for ${dateOf(c)} has already been sent to the clearinghouse once and cannot be grouped. ` +
        'Reconcile it first.');
    }
    const amount = money(c.billed_amount);
    if (amount == null || amount <= 0) {
      add('missing_amount',
        `The claim for ${dateOf(c)} has no billed amount. Every service line needs its own charge, ` +
        'because the payer requires the lines to add up to the claim total.');
    }
  });

  // --- must-match claim-level fields ----------------------------------------
  const first = rows[0];
  CLAIM_LEVEL_FIELDS.forEach(({ key, label }) => {
    const differs = rows.some((c) => (c[key] || null) !== (first[key] || null));
    if (differs) {
      add('mixed_' + key,
        `These claims do not share the same ${label}. One claim form carries a single ${label}, ` +
        'so they have to be filed separately.');
    }
  });

  if (rows.some((c) => !sameDiagnoses(c.diagnosis_codes, first.diagnosis_codes))) {
    add('mixed_diagnoses',
      'These claims do not carry the same diagnosis codes. Diagnoses sit on the claim, not the ' +
      'service line, so grouping them would file every session under one session\'s diagnoses. ' +
      'Make them match on the sessions first, or file these separately.');
  }

  // --- the same session must not appear twice --------------------------------
  const bySession = Object.create(null);
  rows.forEach((c) => {
    const sid = c.session_id;
    if (!sid) return;
    if (bySession[sid]) {
      add('duplicate_session',
        `Two of the selected claims bill the same session (${dateOf(c)}). ` +
        'Grouping them would bill the payer for it twice.');
    }
    bySession[sid] = true;
  });

  if (conflicts.length) return { ok: false, conflicts };

  const total = rows.reduce((sum, c) => sum + money(c.billed_amount), 0);
  return {
    ok: true,
    conflicts: [],
    // Rounded to cents: a sum of numeric(12,2) values can land on a binary
    // floating-point value like 449.99999999999994, and the claim charge must
    // equal the sum of the line charges exactly or the payer rejects the filing.
    total: Math.round(total * 100) / 100,
    lines: rows.length,
  };
}

// Order service lines by date of service, earliest first, so the filed claim
// reads like the calendar and a resubmission emits the same order. Claims with
// no date sort last rather than being dropped.
function orderForFiling(claims) {
  return (claims || []).slice().sort((a, b) => {
    const x = (a && a.session_date) ? String(a.session_date).slice(0, 10) : '9999-12-31';
    const y = (b && b.session_date) ? String(b.session_date).slice(0, 10) : '9999-12-31';
    if (x < y) return -1;
    if (x > y) return 1;
    return 0;
  });
}

module.exports = {
  MAX_GROUPED_LINES,
  CLAIM_LEVEL_FIELDS,
  normalizedDiagnoses,
  sameDiagnoses,
  isReplacement,
  evaluateGroup,
  orderForFiling,
};
