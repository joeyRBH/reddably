'use strict';

// Calendar-event → client name matcher.
//
// SimplePractice writes the client's display name into the event title in one
// of three de-identified formats, plus the full name:
//
//   "Sarah M"        first name + last initial
//   "S M"            first initial + last initial
//   "S Miller"       first initial + last name
//   "Sarah Miller"   full name
//
// matchEvent(summaryRaw, candidates) compares the LEADING portion of the title
// (trailing text like "— intake" is ignored) against those four forms built
// from each candidate's first_name / last_name, with preferred_name as an
// additional first-name variant. Comparison is case-insensitive and ignores
// punctuation and extra whitespace.
//
// A match is a SUGGESTION only — the caller stages it as match_state 'matched'
// and a human confirms before any session exists. Because of that, ambiguity is
// fatal by design: if more than one candidate matches at the highest confidence
// tier found, NO candidate is returned (reason 'ambiguous') and the row stays
// unmatched. Two clients named "Sarah M" must never be silently resolved.
//
// PHI: the returned `reason` names the FORMAT that matched ('full_name', ...),
// never the client's name and never any part of summary_raw.

// Confidence tiers, most to least specific.
const CONFIDENCE = {
  calendar_display_name: 100,
  full_name: 100,
  first_name_last_initial: 90,
  first_initial_last_name: 90,
  initials: 70,
};

// Lowercase, strip punctuation, collapse whitespace → array of word tokens.
// "O'Brien" folds to "obrien" (punctuation removed in place, not split) so the
// same folding applied to both the title and the candidate names stays aligned.
function tokens(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, '')
    .split(/\s+/)
    .filter(Boolean);
}

// True when the title's leading tokens are exactly `form` (the event title may
// carry trailing text after the name — "Sarah M — intake").
function leadingMatch(titleTokens, form) {
  if (form.length === 0 || titleTokens.length < form.length) return false;
  for (let i = 0; i < form.length; i++) {
    if (titleTokens[i] !== form[i]) return false;
  }
  return true;
}

// The four comparison forms for one (first, last) name pair, as token arrays.
// A multi-word first or last name contributes all of its tokens; the initial
// forms use the first token's initial.
function formsFor(first, last) {
  const f = tokens(first);
  const l = tokens(last);
  if (f.length === 0 || l.length === 0) return [];
  const fi = f[0].charAt(0);
  const li = l[0].charAt(0);
  return [
    { reason: 'full_name', form: f.concat(l) },
    { reason: 'first_name_last_initial', form: f.concat([li]) },
    { reason: 'first_initial_last_name', form: [fi].concat(l) },
    { reason: 'initials', form: [fi, li] },
  ];
}

// Best (highest-confidence) form of one candidate that matches the title, or
// null. preferred_name substitutes for first_name as an additional variant.
function bestForCandidate(titleTokens, candidate) {
  const variants = [candidate.first_name];
  if (candidate.preferred_name) variants.push(candidate.preferred_name);

  let best = null;

  // The name this client appears under in the practice EHR's calendar titles,
  // when the practice recorded one. Compared VERBATIM as a leading match rather
  // than being decomposed into first/last forms: it exists precisely BECAUSE the
  // title does not resolve to this client's first and last name, so re-deriving
  // those four forms from it would reintroduce the mismatch it was recorded to
  // fix. Top confidence, since it is an explicit human statement of identity
  // rather than an inference — but still only a SUGGESTION: ambiguity below is
  // still fatal, and promotion still requires human confirmation.
  if (candidate.calendar_display_name) {
    const form = tokens(candidate.calendar_display_name);
    if (form.length && leadingMatch(titleTokens, form)) {
      best = { confidence: CONFIDENCE.calendar_display_name, reason: 'calendar_display_name' };
    }
  }

  for (const first of variants) {
    for (const { reason, form } of formsFor(first, candidate.last_name)) {
      if (!leadingMatch(titleTokens, form)) continue;
      const confidence = CONFIDENCE[reason];
      if (!best || confidence > best.confidence) best = { confidence, reason };
    }
  }
  return best;
}

// matchEvent(summaryRaw, candidates) ->
//   { clientId, confidence, reason }                       one clear winner
//   { clientId: null, confidence: null, reason: 'ambiguous' }
//                                                          >1 candidate at the
//                                                          highest tier found
//   null                                                   nothing matched
//
// candidates: [{ id, first_name, last_name, preferred_name, calendar_display_name }]
// — the practice's active clients.
function matchEvent(summaryRaw, candidates) {
  const titleTokens = tokens(summaryRaw);
  if (titleTokens.length === 0) return null;

  const hits = [];
  for (const candidate of candidates || []) {
    if (!candidate || !candidate.id) continue;
    const best = bestForCandidate(titleTokens, candidate);
    if (best) hits.push({ clientId: candidate.id, ...best });
  }
  if (hits.length === 0) return null;

  const top = Math.max(...hits.map((h) => h.confidence));
  const winners = hits.filter((h) => h.confidence === top);
  if (winners.length > 1) {
    return { clientId: null, confidence: null, reason: 'ambiguous' };
  }
  return winners[0];
}

module.exports = { matchEvent };
