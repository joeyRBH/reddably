'use strict';

// Unit tests — calendar-event → client name matcher (backend/lib/calendar_match.js).
//
// Covers:
//   * each of the four title formats matches the right client at the right
//     confidence ("Sarah M" / "S M" / "S Miller" / "Sarah Miller");
//   * trailing text after the name is ignored; comparison is case-insensitive
//     and punctuation-blind;
//   * preferred_name matches as an additional first-name variant;
//   * two clients matching at the same (highest) tier → no client, reason
//     'ambiguous' — never a silent resolution;
//   * a clear-winner tier beats a lower-tier crowd;
//   * nothing matching → null.
//
// Pure function — no DB, no network, no stubs.
//
//   node backend/tests/calendar_match.test.js

const assert = require('node:assert');
const path = require('node:path');

const { matchEvent } = require(path.join(__dirname, '..', 'lib', 'calendar_match.js'));

const SARAH = { id: 'client-sarah', first_name: 'Sarah', last_name: 'Miller', preferred_name: null };
const DAVID = { id: 'client-david', first_name: 'David', last_name: 'Okafor', preferred_name: null };
const ROSTER = [SARAH, DAVID];

// --- the four formats --------------------------------------------------------

function testFourFormats() {
  const cases = [
    { title: 'Sarah Miller', confidence: 100, reason: 'full_name' },
    { title: 'Sarah M', confidence: 90, reason: 'first_name_last_initial' },
    { title: 'S Miller', confidence: 90, reason: 'first_initial_last_name' },
    { title: 'S M', confidence: 70, reason: 'initials' },
  ];
  for (const c of cases) {
    const hit = matchEvent(c.title, ROSTER);
    assert.ok(hit, `"${c.title}" matched`);
    assert.strictEqual(hit.clientId, SARAH.id, `"${c.title}" → the right client`);
    assert.strictEqual(hit.confidence, c.confidence, `"${c.title}" confidence`);
    assert.strictEqual(hit.reason, c.reason, `"${c.title}" reason`);
  }
  console.log('PASS each of the four name formats matches the right client');
}

// --- normalization: trailing text, case, punctuation -------------------------

function testNormalization() {
  const variants = [
    'Sarah M — intake',            // trailing text after the name
    'sarah m.',                    // lowercase + punctuation
    '  Sarah   M   (50 min)',      // extra whitespace + trailing text
  ];
  for (const title of variants) {
    const hit = matchEvent(title, ROSTER);
    assert.ok(hit && hit.clientId === SARAH.id, `"${title}" matches Sarah`);
    assert.strictEqual(hit.confidence, 90, `"${title}" is first name + last initial`);
  }

  // Punctuation inside a name folds in place: O'Brien ≡ OBrien.
  const obrien = { id: 'client-obrien', first_name: 'Liam', last_name: "O'Brien" };
  const hit = matchEvent('Liam OBrien', [obrien]);
  assert.ok(hit && hit.clientId === obrien.id, 'punctuated last name still matches');
  assert.strictEqual(hit.confidence, 100);

  // "Sarah Mill" is neither the full name nor first + last initial — no match.
  assert.strictEqual(matchEvent('Sarah Mill', ROSTER), null, 'a partial last name never matches');

  console.log('PASS trailing text, case, and punctuation are ignored');
}

// --- preferred_name ----------------------------------------------------------

function testPreferredName() {
  const sally = { id: 'client-sally', first_name: 'Sarah', last_name: 'Nguyen', preferred_name: 'Sally' };

  const full = matchEvent('Sally Nguyen', [sally, DAVID]);
  assert.ok(full && full.clientId === sally.id, 'preferred full name matches');
  assert.strictEqual(full.confidence, 100);

  const initial = matchEvent('Sally N', [sally, DAVID]);
  assert.ok(initial && initial.clientId === sally.id, 'preferred + last initial matches');
  assert.strictEqual(initial.confidence, 90);

  // The legal first name still works alongside the preferred variant.
  const legal = matchEvent('Sarah Nguyen', [sally, DAVID]);
  assert.ok(legal && legal.clientId === sally.id, 'legal first name still matches');

  console.log('PASS preferred_name is matched as well as first_name');
}

// --- ambiguity ---------------------------------------------------------------

function testAmbiguity() {
  const sarahM = { id: 'client-sarah-2', first_name: 'Sarah', last_name: 'Martinez' };

  // "Sarah M" fits both Miller and Martinez at 90 → no silent resolution.
  const tie = matchEvent('Sarah M', [SARAH, sarahM]);
  assert.ok(tie, 'ambiguity is reported, not dropped');
  assert.strictEqual(tie.clientId, null, 'no client is resolved');
  assert.strictEqual(tie.confidence, null);
  assert.strictEqual(tie.reason, 'ambiguous');

  // "Sarah Miller" matches Miller at 100 and Martinez only at 90 — the higher
  // tier has a single winner, so it resolves.
  const winner = matchEvent('Sarah Miller', [SARAH, sarahM]);
  assert.ok(winner && winner.clientId === SARAH.id, 'a clear top tier resolves');
  assert.strictEqual(winner.confidence, 100);

  // "S M" fits everyone whose initials collide → ambiguous at 70.
  const initials = matchEvent('S M', [SARAH, sarahM]);
  assert.strictEqual(initials.reason, 'ambiguous');

  console.log('PASS two clients matching the same title returns no client with reason ambiguous');
}

// --- no match ----------------------------------------------------------------

function testNoMatch() {
  assert.strictEqual(matchEvent('Team meeting', ROSTER), null);
  assert.strictEqual(matchEvent('', ROSTER), null);
  assert.strictEqual(matchEvent(null, ROSTER), null);
  assert.strictEqual(matchEvent('Sarah Miller', []), null);
  console.log('PASS unmatchable titles return null');
}

testFourFormats();
testNormalization();
testPreferredName();
testAmbiguity();
testNoMatch();
console.log('PASS calendar_match.test.js');
