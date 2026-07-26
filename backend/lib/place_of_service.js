'use strict';

// CMS Place of Service codes the app accepts on sessions.place_of_service
// (837P 2300/CLM05-01 / CMS-1500 Box 24B). Deliberately NOT the full CMS table:
// behavioral-health telehealth and office practice only. A payer rejects any
// value that is not a two-character CMS code (e.g. the literal word "office"),
// so everything that writes or transmits the field validates against this list.
// Shared by handlers/sessions.js (save), handlers/claims.js (submit gate), and
// lib/clearinghouse/stedi.js (837P builder).
const PLACE_OF_SERVICE_CODES = [
  { code: '02', label: 'Telehealth (patient not in their home)' },
  { code: '10', label: 'Telehealth (patient in their home)' },
  { code: '11', label: 'Office' },
  { code: '12', label: 'Home' },
  { code: '49', label: 'Independent clinic' },
  { code: '53', label: 'Community mental health center' },
];

const VALID_CODES = new Set(PLACE_OF_SERVICE_CODES.map((e) => e.code));

// True only for a string that is exactly one of the two-character codes above.
// Callers trim before calling (an empty/absent value is THEIR call to allow —
// a session may be saved before billing details are known).
function isValidPlaceOfService(value) {
  return typeof value === 'string' && value.length === 2 && VALID_CODES.has(value);
}

module.exports = {
  PLACE_OF_SERVICE_CODES,
  isValidPlaceOfService,
};
