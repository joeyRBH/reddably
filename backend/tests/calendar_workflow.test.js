'use strict';

// Unit test — Calendar workflow bucketing (public/app/views/calendar.js).
//
// The Calendar view separates two decisions that used to share one ambiguous
// "Confirm" button:
//
//   Sync -> Match client -> Scheduled session -> Confirm session -> Draft claim
//
// buildWorkflow() is the pure function that sorts the loaded resources into the
// view's four sections. It is the safety boundary, so it is pinned here:
//
//   * "waiting to be confirmed" is CROSS-RESOURCE and CALENDAR-SOURCED ONLY —
//     the intersection of confirmed calendar events carrying a session_id and
//     sessions still in 'scheduled'. A manually created scheduled session has no
//     calendar event and must never appear;
//   * a missing or unparseable ends_at can NEVER make a session confirmable
//     (session_date is not consulted at all);
//   * past work sorts ends_at DESC, upcoming appointments sort starts_at ASC —
//     two deliberately different orders, not one global sort;
//   * unpromoted past appointments stay visible for matching, and ignored
//     appointments stay visible and reversible.
//
// The file is a browser IIFE that can't be require()d under Node, so the two
// pure helpers are sliced out of the source and evaluated (same approach as
// backend/tests/scrub_vendor.test.js). Source-level pins for the labels, the API
// calls, and the cache-buster follow at the end.
//
// Fixtures are synthetic ids and placeholder titles only — no PHI.
//
//   node backend/tests/calendar_workflow.test.js

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CALENDAR_JS = path.join(__dirname, '..', '..', 'public', 'app', 'views', 'calendar.js');
const APP_HTML = path.join(__dirname, '..', '..', 'public', 'app', 'app.html');

const src = fs.readFileSync(CALENDAR_JS, 'utf8');

// Pull a 2-space-indented function out of the IIFE (its closing brace is the
// first `\n  }` after the declaration).
function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, name + ' is defined in public/app/views/calendar.js');
  const end = src.indexOf('\n  }', start);
  assert.ok(end !== -1, 'found the end of ' + name);
  return src.slice(start, end + 4);
}

const buildWorkflow = new Function(
  extract('msOf') + '\n' + extract('buildWorkflow') + '\nreturn buildWorkflow;'
)();

// --- fixtures ----------------------------------------------------------------

const NOW = Date.parse('2026-07-28T18:00:00Z');
const T = (iso) => new Date(iso).toISOString();

function ev(id, overrides) {
  return Object.assign({
    id: id,
    summary_raw: 'Appointment ' + id,
    starts_at: null,
    ends_at: null,
    duration_minutes: 50,
    event_status: 'confirmed',
    match_state: 'unmatched',
    matched_client_id: null,
    matched_client_name: null,
    match_confidence: null,
    session_id: null,
  }, overrides);
}

function session(id, status) {
  return { id: id, status: status, session_date: '2026-07-28' };
}

// Promoted + ended + still scheduled -> awaiting confirmation.
const E_ENDED_RECENT = ev('e-ended-recent', {
  match_state: 'confirmed', session_id: 's-recent', matched_client_name: 'Client A',
  starts_at: T('2026-07-28T14:00:00Z'), ends_at: T('2026-07-28T15:00:00Z'),
});
const E_ENDED_OLDER = ev('e-ended-older', {
  match_state: 'confirmed', session_id: 's-older', matched_client_name: 'Client B',
  starts_at: T('2026-07-27T14:00:00Z'), ends_at: T('2026-07-27T15:00:00Z'),
});
// Promoted, ended, but no end time at all (an all-day appointment) — the
// session exists, yet it must never become confirmable from here.
const E_ENDED_NO_END = ev('e-ended-no-end', {
  match_state: 'confirmed', session_id: 's-no-end',
  starts_at: T('2026-07-26T00:00:00Z'), ends_at: null,
});
// Promoted, ended, but its session already advanced past 'scheduled'.
const E_ALREADY_CONFIRMED = ev('e-already-confirmed', {
  match_state: 'confirmed', session_id: 's-claim-ready',
  starts_at: T('2026-07-28T10:00:00Z'), ends_at: T('2026-07-28T11:00:00Z'),
});
// Promoted but still ahead -> upcoming, scheduled state only.
const E_FUTURE_PROMOTED = ev('e-future-promoted', {
  match_state: 'confirmed', session_id: 's-future', matched_client_name: 'Client C',
  starts_at: T('2026-07-30T14:00:00Z'), ends_at: T('2026-07-30T15:00:00Z'),
});
// In progress right now: started, has not ended.
const E_IN_PROGRESS = ev('e-in-progress', {
  match_state: 'confirmed', session_id: 's-in-progress',
  starts_at: T('2026-07-28T17:30:00Z'), ends_at: T('2026-07-28T18:30:00Z'),
});
// Unpromoted and past -> needs a client.
const E_PAST_UNMATCHED = ev('e-past-unmatched', {
  match_state: 'unmatched',
  starts_at: T('2026-07-28T09:00:00Z'), ends_at: T('2026-07-28T10:00:00Z'),
});
const E_PAST_SUGGESTED = ev('e-past-suggested', {
  match_state: 'matched', matched_client_id: 'c-1', matched_client_name: 'Client D',
  match_confidence: 92,
  starts_at: T('2026-07-25T09:00:00Z'), ends_at: T('2026-07-25T10:00:00Z'),
});
const E_PAST_BAD_END = ev('e-past-bad-end', {
  match_state: 'unmatched',
  starts_at: T('2026-07-24T09:00:00Z'), ends_at: 'not-a-timestamp',
});
// Unpromoted and ahead -> upcoming.
const E_FUTURE_UNMATCHED = ev('e-future-unmatched', {
  match_state: 'unmatched',
  starts_at: T('2026-07-29T09:00:00Z'), ends_at: T('2026-07-29T10:00:00Z'),
});
// A future all-day appointment syncs with no end time — it must read as
// upcoming, not as past work.
const E_FUTURE_ALL_DAY = ev('e-future-all-day', {
  match_state: 'matched', matched_client_id: 'c-2', matched_client_name: 'Client E',
  starts_at: T('2026-07-31T00:00:00Z'), ends_at: null,
});
const E_IGNORED = ev('e-ignored', {
  match_state: 'ignored',
  starts_at: T('2026-07-20T09:00:00Z'), ends_at: T('2026-07-20T10:00:00Z'),
});
const E_CANCELLED = ev('e-cancelled', {
  event_status: 'cancelled', match_state: 'confirmed', session_id: 's-cancelled',
  starts_at: T('2026-07-28T08:00:00Z'), ends_at: T('2026-07-28T09:00:00Z'),
});

const DATA = {
  pending: [E_PAST_UNMATCHED, E_PAST_SUGGESTED, E_PAST_BAD_END, E_FUTURE_UNMATCHED, E_FUTURE_ALL_DAY],
  confirmed: [
    E_ENDED_RECENT, E_ENDED_OLDER, E_ENDED_NO_END, E_ALREADY_CONFIRMED,
    E_FUTURE_PROMOTED, E_IN_PROGRESS, E_CANCELLED,
  ],
  ignored: [E_IGNORED],
  sessions: [
    session('s-recent', 'scheduled'),
    session('s-older', 'scheduled'),
    session('s-no-end', 'scheduled'),
    session('s-future', 'scheduled'),
    session('s-in-progress', 'scheduled'),
    session('s-cancelled', 'scheduled'),
    session('s-claim-ready', 'claim_ready'),
    // A manually created session: real, scheduled, and NOT calendar-linked.
    session('s-manual', 'scheduled'),
  ],
};

const wf = buildWorkflow(DATA, NOW);
const ids = (rows) => rows.map((r) => r.event.id);

// --- 1. awaiting confirmation is the intersection of the two resources -------

assert.deepStrictEqual(ids(wf.awaiting), ['e-ended-recent', 'e-ended-older'],
  'awaiting = confirmed events with a session_id, joined to still-scheduled sessions');
assert.strictEqual(wf.awaiting[0].session.id, 's-recent');
assert.strictEqual(wf.awaiting[1].session.id, 's-older');
wf.awaiting.forEach((row) => {
  assert.strictEqual(row.event.session_id, row.session.id, 'the row joins on session_id');
  assert.strictEqual(row.session.status, 'scheduled');
});

// A confirmed event whose session already advanced is done — not awaiting.
assert.ok(!ids(wf.awaiting).includes('e-already-confirmed'),
  'a session past scheduled is no longer awaiting confirmation');

// --- 2. a manual scheduled session is never confirmable here ------------------

const awaitingSessionIds = wf.awaiting.map((r) => r.session.id);
assert.ok(!awaitingSessionIds.includes('s-manual'),
  'a scheduled session with no linked calendar event never appears');
assert.strictEqual(
  [].concat(wf.awaiting, wf.matching, wf.upcoming, wf.ignored)
    .filter((r) => r.session && r.session.id === 's-manual').length,
  0,
  'the manual session appears in no section at all'
);

// --- 3. missing / invalid ends_at can never become confirmable ---------------

assert.ok(!ids(wf.awaiting).includes('e-ended-no-end'),
  'no end time -> not confirmable, even though the session is scheduled');
assert.ok(!ids(wf.awaiting).includes('e-past-bad-end'),
  'an unparseable end time -> not confirmable');
wf.awaiting.forEach((row) => {
  assert.strictEqual(typeof row.endMs, 'number');
  assert.ok(row.endMs <= NOW, 'every awaiting row has a valid end time already past');
});

// A past appointment with no usable end time still has to be reachable for
// matching rather than silently disappearing.
assert.ok(ids(wf.matching).includes('e-past-bad-end'),
  'an unmatched past appointment with a bad end time stays visible for matching');

// --- 4. past work sorts ends_at DESC -----------------------------------------

assert.deepStrictEqual(ids(wf.awaiting), ['e-ended-recent', 'e-ended-older'],
  'most recently ended session first');
assert.deepStrictEqual(
  ids(wf.matching),
  ['e-past-unmatched', 'e-past-suggested', 'e-past-bad-end'],
  'past appointments needing a client sort ends_at DESC, unusable end times last'
);

// --- 5. upcoming appointments sort starts_at ASC -----------------------------

assert.deepStrictEqual(
  ids(wf.upcoming),
  ['e-in-progress', 'e-future-unmatched', 'e-future-promoted', 'e-future-all-day'],
  'soonest upcoming appointment first'
);
// Explicitly NOT one global sort: the two sections order opposite ways.
const pastEnds = wf.matching.map((r) => r.endMs === null ? -Infinity : r.endMs);
const upcomingStarts = wf.upcoming.map((r) => r.startMs);
assert.deepStrictEqual(pastEnds.slice().sort((a, b) => b - a), pastEnds, 'past: descending');
assert.deepStrictEqual(upcomingStarts.slice().sort((a, b) => a - b), upcomingStarts, 'upcoming: ascending');

// --- 6. an in-progress appointment is upcoming, never awaiting ---------------

assert.ok(ids(wf.upcoming).includes('e-in-progress'),
  'an appointment that has started but not ended is not past work');
assert.ok(!ids(wf.awaiting).includes('e-in-progress'),
  'an in-progress appointment is never confirmable');
assert.ok(!ids(wf.awaiting).includes('e-future-promoted'),
  'a future appointment is never confirmable');

// --- 7. ignored appointments stay visible; cancelled ones stay out -----------

assert.deepStrictEqual(ids(wf.ignored), ['e-ignored'],
  'ignored appointments keep their own section');
[wf.awaiting, wf.matching, wf.upcoming, wf.ignored].forEach((bucket) => {
  assert.ok(!ids(bucket).includes('e-cancelled'), 'a cancelled appointment appears nowhere');
});

// Empty inputs are safe.
const empty = buildWorkflow({}, NOW);
assert.deepStrictEqual(
  [empty.awaiting.length, empty.matching.length, empty.upcoming.length, empty.ignored.length],
  [0, 0, 0, 0]
);

// --- 8. source pins ----------------------------------------------------------

// Confirming a session is the server's PATCH — the claim is never built here.
assert.ok(
  /api\.sessions\.update\(\s*row\.session\.id,\s*\{\s*status:\s*'completed'\s*\}\s*\)/.test(src),
  "confirming calls api.sessions.update(session.id, { status: 'completed' })"
);
assert.ok(!/api\.claims\.create/.test(src), 'the view never creates a claim itself');

// Matching a client is the existing promotion endpoint, and promotion is never
// a delete: no calendar-event row is removed by this view.
assert.ok(/api\.calendarEvents\.promote\(ev\.id,\s*clientId\)/.test(src),
  'matching a client calls calendarEvents.promote(id, clientId)');
assert.ok(!/\.remove\(/.test(src) && !/'DELETE'/.test(src),
  'the view issues no delete of any kind');

// The two labels stay distinct, and the old ambiguous one is gone.
assert.ok(src.includes("'Match client'"), 'the matching label is "Match client"');
assert.ok(src.includes("'Confirm session'"), 'the confirmation label is "Confirm session"');
assert.ok(!/,\s*'Confirm'\)/.test(src),
  'no button is labelled the ambiguous bare "Confirm"');

// Comments describe these rules; the code has to obey them, so strip block and
// line comments before checking.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

// Everything goes through the shared client — no direct network access.
assert.ok(!/\bfetch\(/.test(code), 'no direct fetch() in the view');

// Design tokens only: no raw hex.
assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(code), 'no raw hex colors — semantic tokens only');

// --- 9. the calendar.js cache-buster moved -----------------------------------

const appHtml = fs.readFileSync(APP_HTML, 'utf8');
const bust = appHtml.match(/\.\/views\/calendar\.js\?v=([^"']+)/);
assert.ok(bust, 'app.html loads views/calendar.js with a cache-buster');
assert.notStrictEqual(bust[1], '20260715a',
  'the calendar.js cache-buster is bumped off its pre-change value');

console.log('PASS calendar_workflow.test.js');
