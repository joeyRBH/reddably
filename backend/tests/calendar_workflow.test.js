'use strict';

// Unit test — Calendar workflow bucketing (public/app/views/calendar.js).
//
// The Calendar view separates two decisions that used to share one ambiguous
// "Confirm" button:
//
//   Sync -> Match client -> Scheduled session -> Confirm session -> Draft claim
//
// buildCalendarWorkflow() is the pure function that sorts the loaded resources
// into the view's four sections. It now lives in public/app/workflow.js
// (window.Reddably.workflow) — ONE classifier shared by Calendar and the
// Dashboard, so the two surfaces can never disagree about what is waiting. Its
// behavior is unchanged by that move, which is exactly what this file pins.
//
// It is the safety boundary, so it is pinned here:
//
//   * "waiting to be confirmed" is CROSS-RESOURCE and CALENDAR-SOURCED ONLY —
//     the intersection of confirmed calendar events carrying a session_id and
//     sessions still in 'scheduled'. A manually created scheduled session has no
//     calendar event and must never appear;
//   * the end-time fallback is SYMMETRIC across the two loops — ends_at when
//     usable, starts_at otherwise — so an all-day appointment (ends_at null)
//     travels needs-a-client -> awaiting -> gone instead of leaving `matching`
//     on promotion and landing in no bucket at all (session_date is still never
//     consulted, and an event with no usable time at ALL is still never
//     confirmable);
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
const DASHBOARD_JS = path.join(__dirname, '..', '..', 'public', 'app', 'views', 'dashboard.js');
const WORKFLOW_JS = path.join(__dirname, '..', '..', 'public', 'app', 'workflow.js');
const APP_HTML = path.join(__dirname, '..', '..', 'public', 'app', 'app.html');

const src = fs.readFileSync(CALENDAR_JS, 'utf8');
const dashboardSrc = fs.readFileSync(DASHBOARD_JS, 'utf8');
const workflowSrc = fs.readFileSync(WORKFLOW_JS, 'utf8');

// Pull a 2-space-indented function out of the IIFE (its closing brace is the
// first `\n  }` after the declaration).
function extract(name) {
  const start = workflowSrc.indexOf('function ' + name + '(');
  assert.ok(start !== -1, name + ' is defined in public/app/workflow.js');
  const end = workflowSrc.indexOf('\n  }', start);
  assert.ok(end !== -1, 'found the end of ' + name);
  return workflowSrc.slice(start, end + 4);
}

const buildWorkflow = new Function(
  extract('msOf') + '\n' + extract('buildCalendarWorkflow') + '\nreturn buildCalendarWorkflow;'
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
// Promoted, past, but no end time at all (an all-day appointment). It is placed
// by its START — the same fallback the unpromoted loop uses — so it reaches
// confirmation instead of vanishing out of every bucket on promotion.
const E_ENDED_NO_END = ev('e-ended-no-end', {
  match_state: 'confirmed', session_id: 's-no-end',
  starts_at: T('2026-07-26T00:00:00Z'), ends_at: null,
});
// Promoted, no end time, and its start is still ahead -> upcoming, never
// confirmable early.
const E_FUTURE_PROMOTED_NO_END = ev('e-future-promoted-no-end', {
  match_state: 'confirmed', session_id: 's-future-no-end',
  starts_at: T('2026-08-02T00:00:00Z'), ends_at: null,
});
// Promoted with NO usable time of any kind: unplaceable, so it stays out of
// every bucket rather than being guessed into one.
const E_NO_TIMES = ev('e-no-times', {
  match_state: 'confirmed', session_id: 's-no-times',
  starts_at: null, ends_at: null,
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
    E_FUTURE_PROMOTED, E_FUTURE_PROMOTED_NO_END, E_NO_TIMES, E_IN_PROGRESS,
    E_CANCELLED,
  ],
  ignored: [E_IGNORED],
  sessions: [
    session('s-recent', 'scheduled'),
    session('s-older', 'scheduled'),
    session('s-no-end', 'scheduled'),
    session('s-future-no-end', 'scheduled'),
    session('s-no-times', 'scheduled'),
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

assert.deepStrictEqual(ids(wf.awaiting),
  ['e-ended-recent', 'e-ended-older', 'e-ended-no-end'],
  'awaiting = confirmed events with a session_id, joined to still-scheduled sessions');
assert.strictEqual(wf.awaiting[0].session.id, 's-recent');
assert.strictEqual(wf.awaiting[1].session.id, 's-older');
assert.strictEqual(wf.awaiting[2].session.id, 's-no-end');
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

// --- 3. the end-time fallback is symmetric across both loops -----------------

// An all-day appointment (ends_at null) is placed by its START in BOTH loops.
// Promoted and past, that makes it confirmable rather than invisible: before
// this fallback it left `matching` on promotion and landed in no bucket at all,
// stranding its session in 'scheduled' forever.
assert.ok(ids(wf.awaiting).includes('e-ended-no-end'),
  'a promoted, past all-day appointment reaches confirmation');
assert.strictEqual(wf.awaiting.filter((r) => r.event.id === 'e-ended-no-end')[0].endMs, null,
  'it gets there on its start time — endMs really is null');

// The fallback places by start; it does not make everything confirmable.
assert.ok(ids(wf.upcoming).includes('e-future-promoted-no-end'),
  'an all-day appointment whose start is still ahead stays upcoming');
assert.ok(!ids(wf.awaiting).includes('e-future-promoted-no-end'),
  'a future all-day appointment is never confirmable early');

// No usable time of any kind -> unplaceable, so it is guessed into no bucket.
[wf.awaiting, wf.matching, wf.upcoming, wf.ignored].forEach((bucket) => {
  assert.ok(!ids(bucket).includes('e-no-times'),
    'an event with neither start nor end appears nowhere');
});

// session_date is still never consulted to decide confirmability. Comments
// discuss it, so strip block AND line comments before checking the code.
assert.ok(!/session_date/.test(
  workflowSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
), 'the classifier never reads session_date');

// Every awaiting row is genuinely past by whichever time placed it.
wf.awaiting.forEach((row) => {
  const effective = row.endMs === null ? row.startMs : row.endMs;
  assert.strictEqual(typeof effective, 'number');
  assert.ok(effective <= NOW, 'every awaiting row is already past');
});

// An unpromoted past appointment with a bad end time is unchanged: still
// reachable for matching rather than silently disappearing, still not awaiting.
assert.ok(!ids(wf.awaiting).includes('e-past-bad-end'),
  'an unpromoted event is never awaiting, whatever its end time');
assert.ok(ids(wf.matching).includes('e-past-bad-end'),
  'an unmatched past appointment with a bad end time stays visible for matching');

// --- 4. past work sorts ends_at DESC -----------------------------------------

assert.deepStrictEqual(ids(wf.awaiting),
  ['e-ended-recent', 'e-ended-older', 'e-ended-no-end'],
  'most recently ended session first; an unusable end time sorts last');
assert.deepStrictEqual(
  ids(wf.matching),
  ['e-past-unmatched', 'e-past-suggested', 'e-past-bad-end'],
  'past appointments needing a client sort ends_at DESC, unusable end times last'
);

// --- 5. upcoming appointments sort starts_at ASC -----------------------------

assert.deepStrictEqual(
  ids(wf.upcoming),
  ['e-in-progress', 'e-future-unmatched', 'e-future-promoted', 'e-future-all-day',
   'e-future-promoted-no-end'],
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

// --- 9. ONE classifier, shared by Calendar and Dashboard ---------------------

// The implementation lives in workflow.js and attaches to the EXISTING
// namespace — not a new global.
assert.ok(/function buildCalendarWorkflow\(data, nowMs\)/.test(workflowSrc),
  'public/app/workflow.js owns the classifier');
assert.ok(/R\.workflow\s*=\s*\{/.test(workflowSrc) && /var R = window\.Reddably;/.test(workflowSrc),
  'it hangs off window.Reddably, creating no unrelated global');
assert.ok(!/window\.[A-Za-z_$][\w$]*\s*=/.test(
  workflowSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
), 'workflow.js assigns no new window global');

// Both views consume that one function...
[[src, 'calendar.js'], [dashboardSrc, 'dashboard.js']].forEach(([text, name]) => {
  assert.ok(/R\.workflow(\s*&&\s*R\.workflow)?\.buildCalendarWorkflow|workflow\.buildCalendarWorkflow/.test(text),
    name + ' calls the shared buildCalendarWorkflow');
  // ...and neither keeps a copy of the rules.
  assert.ok(!/function buildWorkflow\s*\(/.test(text),
    name + ' contains no copied buildWorkflow implementation');
  assert.ok(!/function buildCalendarWorkflow\s*\(/.test(text),
    name + ' does not re-implement the classifier');
  assert.ok(!/function msOf\s*\(/.test(text),
    name + ' does not re-implement the end-time parser');
});

// --- 10. script order + cache-busters ----------------------------------------

const appHtml = fs.readFileSync(APP_HTML, 'utf8');

const bust = appHtml.match(/\.\/views\/calendar\.js\?v=([^"']+)/);
assert.ok(bust, 'app.html loads views/calendar.js with a cache-buster');
assert.notStrictEqual(bust[1], '20260715a',
  'the calendar.js cache-buster is bumped off its pre-change value');

// The shared helper has to be defined before either consumer registers.
const iWorkflow = appHtml.indexOf('./workflow.js?v=');
const iViews = appHtml.indexOf('./views.js?v=');
const iDashboard = appHtml.indexOf('./views/dashboard.js?v=');
const iCalendar = appHtml.indexOf('./views/calendar.js?v=');
assert.ok(iWorkflow !== -1, 'app.html loads ./workflow.js');
assert.ok(iViews !== -1 && iViews < iWorkflow,
  'workflow.js loads after views.js, which creates window.Reddably');
assert.ok(iWorkflow < iDashboard && iWorkflow < iCalendar,
  'workflow.js loads before both the Dashboard and Calendar views');

// This change edits workflow.js and nothing else, so exactly ONE asset moves.
// The views are untouched source and keep the cache-buster they shipped with —
// re-bumping them would evict warm caches for no reason.
const VERSION = '20260810a';
const bustOf = (asset) => {
  const m = appHtml.match(new RegExp(asset.replace(/[.\/]/g, '\\$&') + '\\?v=([^"\']+)'));
  assert.ok(m, 'app.html loads ' + asset);
  return m[1];
};
assert.strictEqual(bustOf('./workflow.js'), VERSION,
  'the edited classifier carries the new cache-buster');
assert.strictEqual(
  (appHtml.match(new RegExp('\\?v=' + VERSION, 'g')) || []).length, 1,
  'exactly one asset carries the new cache-buster'
);
assert.strictEqual(bustOf('./views/dashboard.js'), '20260728c',
  'the Dashboard cache-buster is untouched — its source did not change');
assert.strictEqual(bustOf('./views/calendar.js'), '20260728c',
  'the Calendar cache-buster is untouched — its source did not change');
// claims.js has since been re-bumped by the per-client billing defaults change
// (the Edit-claim form gained the "save as defaults" control). Still pinned, so
// that an unintended bump is still caught — just at its current value.
assert.strictEqual(bustOf('./views/claims.js'), '20260824a',
  'the Claims cache-buster is at its current value');

console.log('PASS calendar_workflow.test.js');
