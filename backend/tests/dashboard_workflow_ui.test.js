'use strict';

// Unit test — Dashboard work homepage (public/app/views/dashboard.js).
//
// The Dashboard is no longer a metrics page: it is the entry point to
//
//   Sync -> Match -> Confirm -> Verify -> Submit -> Track
//
// What this pins, because each of these is a way the page could quietly lie:
//
//   * "Sessions to confirm" is the SHARED calendar classifier's awaiting bucket
//     (public/app/workflow.js) — the same cross-resource, calendar-sourced
//     definition Calendar uses. A manually created scheduled session and an
//     appointment with no usable end time are never counted;
//   * "Appointments to match" counts only pending events not yet promoted;
//   * claim work splits on readiness state: needs_correction is its own card,
//     and EVERY other draft — including one whose readiness the server did not
//     project — stays in human review. No card ever claims a draft is "Ready to
//     submit": nothing persists a clinician's verification, so that state does
//     not exist;
//   * follow-up is info_requested + denied only, never ordinary submitted /
//     processing / paid / appealed / void;
//   * only nonzero cards render, and all-zero renders one calm caught-up state;
//   * reporting reuses GET /reports verbatim with accurate labels — no
//     "this month", no "paid", no client-side financial arithmetic;
//   * the workflow and reporting groups fail INDEPENDENTLY, and a failed request
//     never renders as a zero;
//   * no clients request, no per-row detail calls, no direct fetch().
//
// dashboard.js is a browser IIFE, so it is evaluated against a minimal fake DOM
// and a fake window.Reddably kit whose api is a recording stub — no jsdom, no
// network, no real DB, in keeping with the hand-stubbed style of the other tests
// here. workflow.js is loaded for real into the same context, so the classifier
// under test is the shipped one. Fixtures are synthetic ids only — no PHI.
//
//   node backend/tests/dashboard_workflow_ui.test.js

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DASHBOARD_JS = path.join(__dirname, '..', '..', 'public', 'app', 'views', 'dashboard.js');
const WORKFLOW_JS = path.join(__dirname, '..', '..', 'public', 'app', 'workflow.js');

// --- a minimal fake DOM ------------------------------------------------------

function textNode(value) {
  return { nodeType: 3, textContent: String(value), childNodes: [] };
}

function createElement(tag) {
  const el = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    className: '',
    attributes: {},
    dataset: {},
    childNodes: [],
    listeners: {},
    parentNode: null,
    disabled: false,
    value: '',
    appendChild(child) {
      child.parentNode = el;
      el.childNodes.push(child);
      return child;
    },
    removeChild(child) {
      const i = el.childNodes.indexOf(child);
      if (i !== -1) el.childNodes.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    setAttribute(name, value) {
      el.attributes[name] = String(value);
      if (name === 'disabled') el.disabled = true;
    },
    addEventListener(type, fn) {
      (el.listeners[type] || (el.listeners[type] = [])).push(fn);
    },
    dispatch(type, arg) {
      (el.listeners[type] || []).forEach((fn) => fn(arg || { target: el }));
    },
    get firstChild() { return el.childNodes[0]; },
  };
  Object.defineProperty(el, 'textContent', {
    get() { return el.childNodes.map((c) => c.textContent).join(''); },
    set(v) { el.childNodes = [textNode(v)]; },
  });
  return el;
}

const fakeDocument = { createElement, createTextNode: textNode };

// h() mirroring public/app/views.js.
function h(tag, attrs, children) {
  const el = createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach((key) => {
      const val = attrs[key];
      if (val === null || val === undefined || val === false) return;
      if (key === 'class' || key === 'className') el.className = val;
      else if (key === 'text' || key === 'textContent') el.textContent = val;
      else if (key.indexOf('on') === 0 && typeof val === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), val);
      } else el.setAttribute(key, val);
    });
  }
  append(el, children);
  return el;
}

function append(el, children) {
  if (children === null || children === undefined || children === false) return;
  if (Array.isArray(children)) {
    children.forEach((c) => append(el, c));
    return;
  }
  el.appendChild(children.nodeType ? children : textNode(children));
}

// --- tree helpers ------------------------------------------------------------

function walk(node, out) {
  out = out || [];
  (node.childNodes || []).forEach((c) => {
    if (c.nodeType === 1) {
      out.push(c);
      walk(c, out);
    }
  });
  return out;
}

function tagged(node, tag) {
  return walk(node).filter((el) => el.tagName === tag);
}

// Every attention/report card: a `.card stat` whose first label is the queue.
function cards(root) {
  return walk(root).filter((el) => el.className === 'card stat');
}

function cardLabel(card) {
  const label = walk(card).find((el) => el.className === 'stat__label');
  return label ? label.textContent : null;
}

function cardValue(card) {
  const v = walk(card).find((el) => el.className === 'stat__value');
  return v ? v.textContent : null;
}

function cardActions(card) {
  return tagged(card, 'BUTTON').map((b) => b.textContent);
}

function cardByLabel(root, label) {
  return cards(root).find((c) => cardLabel(c) === label) || null;
}

function labels(root) {
  return cards(root).map(cardLabel);
}

// --- fixtures ----------------------------------------------------------------

const NOW = Date.parse('2026-07-28T18:00:00Z');
const T = (iso) => new Date(iso).toISOString();

// The view classifies against Date.now() (dashboard.js: attentionCounts(data,
// Date.now())), so the sandbox gets a FROZEN clock pinned to NOW — the same
// instant this file's own buildCalendarWorkflow() calls use.
//
// Without it the test was wall-clock dependent and silently rotted: fixtures
// dated 2026-07-28..30 were "future" to the assertions but drifted into the past
// for the render, so the counts diverged and the file began failing on its own
// once real time passed 2026-07-30. Parsing behaviour is untouched — only an
// argument-less `new Date()` and `Date.now()` are pinned.
class FrozenDate extends Date {
  constructor(...args) {
    if (args.length === 0) super(NOW);
    else super(...args);
  }
  static now() { return NOW; }
}

function ev(id, over) {
  return Object.assign({
    id, summary_raw: 'Appointment ' + id, starts_at: null, ends_at: null,
    duration_minutes: 50, event_status: 'confirmed', match_state: 'unmatched',
    matched_client_id: null, matched_client_name: null, session_id: null,
  }, over || {});
}

function claim(over) {
  return Object.assign({
    id: 'x', status: 'draft', billed_amount: '150.00',
    created_at: '2026-06-01T09:00:00.000Z', readiness: { state: 'ready_to_review' },
  }, over || {});
}

const REPORT = {
  claim_count: 42,
  revenue: { billed_total: 6300, allowed_total: 5000, reimbursed_total: 4100 },
  aging: { total_count: 7, total_billed: 1050 },
  pipeline: {}, by_client: [], by_cpt: [],
};

// --- recording api stub ------------------------------------------------------

let calls = [];
let fixtures = null;
let failWork = false;
let failReport = false;

function record(name, args, value) {
  calls.push({ name, args });
  return Promise.resolve(value);
}

const api = {
  me() { return record('me', [], { user: { first_name: 'Joey' } }); },
  calendarEvents: {
    list(filters) {
      calls.push({ name: 'calendarEvents.list', args: [filters || null] });
      if (failWork) return Promise.reject(new Error('calendar unavailable'));
      const state = filters && filters.state;
      return Promise.resolve({
        calendar_events: state === 'confirmed' ? fixtures.confirmed : fixtures.pending,
      });
    },
  },
  sessions: {
    list(filters) {
      calls.push({ name: 'sessions.list', args: [filters || null] });
      if (failWork) return Promise.reject(new Error('sessions unavailable'));
      return Promise.resolve({ sessions: fixtures.sessions });
    },
  },
  claims: {
    list(filters) {
      calls.push({ name: 'claims.list', args: [filters || null] });
      if (failWork) return Promise.reject(new Error('claims unavailable'));
      return Promise.resolve({ claims: fixtures.claims });
    },
  },
  reports: {
    summary(filters) {
      calls.push({ name: 'reports.summary', args: [filters || null] });
      if (failReport) return Promise.reject(new Error('reports unavailable'));
      return Promise.resolve({ report: REPORT });
    },
  },
  clients: {
    list() { return record('clients.list', [], { clients: [] }); },
  },
};

// --- fake window.Reddably kit ------------------------------------------------

function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

let viewFn = null;
const navigations = [];

const Reddably = {
  h,
  api,
  clear,
  renderLoading(root) { clear(root); root.appendChild(h('div', { class: 'skeleton' })); },
  renderError(root, err) {
    clear(root);
    root.appendChild(h('div', { class: 'inline-error' }, String(err && err.message)));
  },
  renderEmpty(root, opts) { clear(root); root.appendChild(h('div', { class: 'empty-state' }, opts.title)); },
  fmtDate(s) { return s ? String(s).slice(0, 10) : '—'; },
  fmtMoney(v) { return v == null ? '—' : '$' + v; },
  statusBadge(status) { return h('span', { class: 'badge badge--neutral' }, status); },
  toast() {},
  navigate(hash) { navigations.push(hash); },
  registerView(name, fn) { if (name === 'dashboard') viewFn = fn; },
};

const fakeWindow = { Reddably };
const sandbox = { window: fakeWindow, document: fakeDocument, console, Promise, Date: FrozenDate };

// The shared classifier is loaded for real — this test must exercise the code
// that actually ships, not a stub that could agree with a bug.
vm.runInNewContext(fs.readFileSync(WORKFLOW_JS, 'utf8'), sandbox);
assert.ok(Reddably.workflow && typeof Reddably.workflow.buildCalendarWorkflow === 'function',
  'workflow.js attaches the shared classifier to window.Reddably');

const dashboardSrc = fs.readFileSync(DASHBOARD_JS, 'utf8');
vm.runInNewContext(dashboardSrc, sandbox);
assert.ok(typeof viewFn === 'function', 'dashboard.js registers the dashboard view');

function flush() {
  return new Promise((resolve) => setImmediate(() => setImmediate(() => setImmediate(
    () => setImmediate(resolve)))));
}

function plain(v) {
  return JSON.parse(JSON.stringify(v === undefined ? null : v));
}

// Render the dashboard against a fixture set and hand back the root.
async function mount(data, opts) {
  fixtures = Object.assign({ pending: [], confirmed: [], sessions: [], claims: [] }, data);
  failWork = !!(opts && opts.failWork);
  failReport = !!(opts && opts.failReport);
  calls = [];
  const root = createElement('div');
  viewFn(root);
  await flush();
  return root;
}

// --- the tests ---------------------------------------------------------------

(async function run() {
  // === 1. the full workload: every attention card, each counted once =========

  // Unmatched, past -> matching work.
  const E_UNMATCHED = ev('e-unmatched', {
    starts_at: T('2026-07-28T09:00:00Z'), ends_at: T('2026-07-28T10:00:00Z'),
  });
  // Suggested but still unpromoted -> also matching work.
  const E_SUGGESTED = ev('e-suggested', {
    match_state: 'matched', matched_client_id: 'c-1',
    starts_at: T('2026-07-29T09:00:00Z'), ends_at: T('2026-07-29T10:00:00Z'),
  });
  // Promoted, ended, session still scheduled -> confirmation work.
  const E_ENDED = ev('e-ended', {
    match_state: 'confirmed', session_id: 's-ended',
    starts_at: T('2026-07-28T14:00:00Z'), ends_at: T('2026-07-28T15:00:00Z'),
  });
  // Promoted but still ahead -> nothing to do yet.
  const E_FUTURE = ev('e-future', {
    match_state: 'confirmed', session_id: 's-future',
    starts_at: T('2026-07-30T14:00:00Z'), ends_at: T('2026-07-30T15:00:00Z'),
  });
  // Promoted and past, with no end time at all (an all-day appointment). Placed
  // by its start, so it IS confirmation work — and the Dashboard has to count it
  // exactly as the Calendar tab lists it.
  const E_NO_END = ev('e-no-end', {
    match_state: 'confirmed', session_id: 's-no-end',
    starts_at: T('2026-07-26T00:00:00Z'), ends_at: null,
  });

  const FULL = {
    pending: [E_UNMATCHED, E_SUGGESTED],
    confirmed: [E_ENDED, E_FUTURE, E_NO_END],
    sessions: [
      { id: 's-ended', status: 'scheduled' },
      { id: 's-future', status: 'scheduled' },
      { id: 's-no-end', status: 'scheduled' },
      // Manually created: real, scheduled, and NOT calendar-linked.
      { id: 's-manual', status: 'scheduled' },
    ],
    claims: [
      claim({ id: 'd-blocked', readiness: { state: 'needs_correction' } }),
      claim({ id: 'd-warn', readiness: { state: 'review_warning' } }),
      claim({ id: 'd-ready', readiness: { state: 'ready_to_review' } }),
      // A draft the server projected no readiness for at all.
      claim({ id: 'd-unknown', readiness: null }),
      claim({ id: 'h-info', status: 'info_requested', readiness: null }),
      claim({ id: 'h-denied', status: 'denied', readiness: null }),
      claim({ id: 'h-submitted', status: 'submitted', readiness: null }),
      claim({ id: 'h-processing', status: 'processing', readiness: null }),
      claim({ id: 'h-paid', status: 'paid', readiness: null }),
      claim({ id: 'h-appealed', status: 'appealed', readiness: null }),
      claim({ id: 'h-void', status: 'void', readiness: null }),
    ],
  };

  const root = await mount(FULL);

  // 1a. The greeting survives.
  const title = walk(root).find((el) => el.className === 'page-header__title');
  assert.strictEqual(title && title.textContent, 'Welcome, Joey',
    'the personalized greeting is kept');

  // 1b. Both sections, attention first.
  const headings = walk(root).filter((el) => el.className === 'card__title')
    .map((el) => el.textContent);
  assert.deepStrictEqual(headings, ['What needs attention', 'Practice overview'],
    'attention is the dominant section; reporting is subordinate');

  // 1c. Exactly the five attention cards, plus the four reporting cards.
  assert.deepStrictEqual(labels(root), [
    'Appointments to match',
    'Sessions to confirm',
    'Claims needing correction',
    'Claims to verify',
    'Claims needing follow-up',
    'Claims tracked',
    'Total billed',
    'Total reimbursed',
    'Outstanding billed',
  ], 'five attention cards, then four reporting cards');

  // 2. Appointments to match: unpromoted pending events only.
  assert.strictEqual(cardValue(cardByLabel(root, 'Appointments to match')), '2',
    'both unpromoted pending events count; promoted ones do not');

  // 3. Sessions to confirm: the shared classifier's awaiting bucket. The ended
  //    session and the past all-day one both count; the future appointment and
  //    the manual session are out.
  assert.strictEqual(cardValue(cardByLabel(root, 'Sessions to confirm')), '2',
    'every past, calendar-linked, still-scheduled session counts');

  //    Pinned against the classifier itself, so the two can never drift.
  const wf = Reddably.workflow.buildCalendarWorkflow({
    pending: FULL.pending, confirmed: FULL.confirmed, sessions: FULL.sessions,
  }, NOW);
  assert.strictEqual(wf.awaiting.length, 2, 'the shared classifier agrees');
  // Array.from rehomes the vm-context array — deepStrictEqual compares
  // prototypes, and a cross-realm Array fails on identity alone.
  assert.deepStrictEqual(Array.from(wf.awaiting, (r) => r.session.id).sort(),
    ['s-ended', 's-no-end'],
    'the ended session and the past all-day one, and nothing else');
  assert.ok(!wf.awaiting.some((r) => r.session && r.session.id === 's-manual'),
    'a manual scheduled session is never awaiting confirmation');
  assert.ok(!wf.awaiting.some((r) => r.event.id === 'e-future'),
    'a future appointment is never confirmable');

  //    The count IS the classifier's bucket length — not a parallel rule.
  assert.strictEqual(
    cardValue(cardByLabel(root, 'Sessions to confirm')), String(wf.awaiting.length),
    'the Dashboard count and the Calendar tab can never disagree');

  // 4. Claims needing correction is needs_correction and nothing else.
  assert.strictEqual(cardValue(cardByLabel(root, 'Claims needing correction')), '1',
    'only the blocked draft is correction work');

  // 5. Claims to verify picks up every remaining draft, including the one whose
  //    readiness is missing — an absent projection is not an approval.
  assert.strictEqual(cardValue(cardByLabel(root, 'Claims to verify')), '3',
    'review_warning + ready_to_review + missing-readiness drafts stay in human review');

  // 6. No card invents a verification state the system does not persist.
  assert.ok(!root.textContent.includes('Ready to submit'),
    'no card claims a draft is "Ready to submit"');
  assert.ok(!/Ready to submit/.test(dashboardSrc),
    'the source carries no "Ready to submit" label either');

  // 7. Follow-up is info_requested + denied only.
  assert.strictEqual(cardValue(cardByLabel(root, 'Claims needing follow-up')), '2',
    'submitted / processing / paid / appealed / void are not attention work');

  // 8. Every attention card has exactly one destination action.
  const ATTENTION_ACTIONS = {
    'Appointments to match': 'Review Calendar',
    'Sessions to confirm': 'Confirm sessions',
    'Claims needing correction': 'Correct claims',
    'Claims to verify': 'Verify claims',
    'Claims needing follow-up': 'Review claims',
  };
  Object.keys(ATTENTION_ACTIONS).forEach((label) => {
    const card = cardByLabel(root, label);
    assert.deepStrictEqual(cardActions(card), [ATTENTION_ACTIONS[label]],
      label + ' offers exactly one action: ' + ATTENTION_ACTIONS[label]);
  });

  // ...and each action reaches the right view.
  const ROUTES = {
    'Appointments to match': 'calendar',
    'Sessions to confirm': 'calendar',
    'Claims needing correction': 'claims',
    'Claims to verify': 'claims',
    'Claims needing follow-up': 'claims',
  };
  Object.keys(ROUTES).forEach((label) => {
    navigations.length = 0;
    tagged(cardByLabel(root, label), 'BUTTON')[0].dispatch('click');
    assert.deepStrictEqual(navigations, [ROUTES[label]],
      label + ' navigates to #' + ROUTES[label]);
  });

  // 9. The Dashboard interprets; it never acts.
  assert.ok(!/\.promote\(|\.submit\(|\.create\(|\.update\(|\.remove\(|'DELETE'/.test(dashboardSrc),
    'the Dashboard creates, confirms, submits and deletes nothing');

  // === 10. reporting: the existing /reports response, labelled accurately ====

  assert.strictEqual(cardValue(cardByLabel(root, 'Claims tracked')), '42');
  assert.strictEqual(cardValue(cardByLabel(root, 'Total billed')), '$6300');
  assert.strictEqual(cardValue(cardByLabel(root, 'Total reimbursed')), '$4100');
  assert.strictEqual(cardValue(cardByLabel(root, 'Outstanding billed')), '$1050');

  ['Claims tracked', 'Total billed', 'Total reimbursed', 'Outstanding billed'].forEach((label) => {
    assert.deepStrictEqual(cardActions(cardByLabel(root, label)), ['View reports'],
      label + ' links to Reports');
  });
  navigations.length = 0;
  tagged(cardByLabel(root, 'Total billed'), 'BUTTON')[0].dispatch('click');
  assert.deepStrictEqual(navigations, ['reports'], 'reporting cards reach #reports');

  // Only the four sanctioned figures are read...
  const REPORT_FIELDS = dashboardSrc.match(/report\.\w+|revenue\.\w+|aging\.\w+/g) || [];
  assert.deepStrictEqual(
    [...new Set(REPORT_FIELDS)].sort(),
    ['aging.total_billed', 'report.aging', 'report.claim_count', 'report.revenue',
      'revenue.billed_total', 'revenue.reimbursed_total'].sort(),
    'reporting reads only claim_count, revenue.billed_total, revenue.reimbursed_total, aging.total_billed'
  );
  // ...and the summary is requested unfiltered (the all-time response).
  assert.deepStrictEqual(
    calls.filter((c) => c.name === 'reports.summary').map((c) => plain(c.args[0])),
    [null],
    'the reports summary is requested once, with no filters'
  );

  // 11. Labels never restate created_at as submitted or paid, and never promise
  //     reimbursement that /reports cannot know.
  [
    /submitted this month/i, /paid this month/i, /this month/i,
    /outstanding reimbursement/i, /expected reimbursement/i,
    /paid to date/i, /revenue collected/i,
  ].forEach((pattern) => {
    assert.ok(!pattern.test(root.textContent),
      'no label misstates the reports semantics: ' + pattern);
  });

  // 12. The old generic page is gone.
  ['Total clients', 'Open claims', 'Paid claims', 'Recent claims'].forEach((gone) => {
    assert.ok(!root.textContent.includes(gone), '"' + gone + '" is removed');
  });

  // === 13. loading discipline ===============================================

  const names = calls.map((c) => c.name).sort();
  assert.deepStrictEqual(names, [
    'calendarEvents.list', 'calendarEvents.list', 'claims.list',
    'me', 'reports.summary', 'sessions.list',
  ].sort(), 'exactly the six read-only calls, each once');

  assert.ok(!calls.some((c) => c.name === 'clients.list'),
    'no clients request remains — the removed Total clients metric is not resurrected');
  assert.deepStrictEqual(
    calls.filter((c) => c.name === 'calendarEvents.list').map((c) => plain(c.args[0])),
    [null, { state: 'confirmed' }],
    'the review queue and confirmed events only — ignored events are never fetched'
  );
  assert.deepStrictEqual(
    calls.filter((c) => c.name === 'claims.list').map((c) => plain(c.args[0])),
    [null], 'claims load once, in one list request');

  // No N+1: nothing is requested per row, and nothing bypasses the API client.
  const code = dashboardSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  assert.ok(!/\bfetch\(/.test(code), 'no direct fetch() in the view');
  assert.ok(!/\.get\(|\.detail\(|\.forEach\([^)]*\)\s*\{[^}]*api\./.test(code),
    'no per-row detail call');
  assert.ok(!/api\.\w+(\.\w+)*\(/.test(code.replace(
    /api\.(me|calendarEvents\.list|sessions\.list|claims\.list|reports\.summary)\(/g, '')),
    'the view calls only the six sanctioned read-only endpoints');

  // Design system: tokens only.
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(code), 'no raw hex colors — semantic tokens only');
  assert.ok(!/\d+px\b/.test(code), 'no raw pixel values — spacing tokens only');
  // Sage stays reserved for resolved state; pending work is stone.
  assert.ok(!/badge--success|color-accent/.test(code),
    'no sage on pending workflow cards');

  // === 14. zero-work: only nonzero cards render =============================

  const partial = await mount({
    pending: [E_UNMATCHED],
    confirmed: [],
    sessions: [{ id: 's-manual', status: 'scheduled' }],
    claims: [claim({ id: 'h-paid', status: 'paid', readiness: null })],
  });
  assert.deepStrictEqual(labels(partial), [
    'Appointments to match',
    'Claims tracked', 'Total billed', 'Total reimbursed', 'Outstanding billed',
  ], 'only the nonzero attention card renders — no zero cards');
  assert.ok(!partial.textContent.includes('Sessions to confirm'),
    'a zero queue is absent, not rendered as 0');

  // === 15. all-clear ========================================================

  const clear0 = await mount({
    pending: [], confirmed: [],
    sessions: [{ id: 's-manual', status: 'scheduled' }],
    claims: [claim({ id: 'h-paid', status: 'paid', readiness: null })],
  });
  assert.ok(
    clear0.textContent.includes(
      'You’re caught up. No appointment matching, session confirmation, ' +
      'or claim-review work is waiting.'),
    'all five at zero renders one calm caught-up state'
  );
  assert.deepStrictEqual(labels(clear0), [
    'Claims tracked', 'Total billed', 'Total reimbursed', 'Outstanding billed',
  ], 'no attention cards at all when nothing is waiting');
  // A disconnected calendar returning an empty list is a real zero, not an error.
  assert.ok(!clear0.textContent.includes('Could not load your workflow'),
    'a successful empty response is a true zero, never an error');

  // === 16. error isolation ==================================================

  // Workflow fails, reporting survives.
  const workDown = await mount(FULL, { failWork: true });
  assert.ok(workDown.textContent.includes('Could not load your workflow'),
    'a workflow failure shows its own inline error');
  assert.deepStrictEqual(labels(workDown), [
    'Claims tracked', 'Total billed', 'Total reimbursed', 'Outstanding billed',
  ], 'reporting stays visible and usable when the workflow group fails');
  // No fabricated zeros anywhere in the failed section.
  assert.ok(!workDown.textContent.includes('Appointments to match'),
    'a failed request renders no count at all — never a zero');
  const workRetry = tagged(workDown, 'BUTTON').find((b) => b.textContent === 'Retry');
  assert.ok(workRetry, 'the workflow error offers Retry');

  // Retrying actually re-issues the workflow group and nothing else.
  calls = [];
  failWork = false;
  workRetry.dispatch('click');
  await flush();
  assert.deepStrictEqual(calls.map((c) => c.name).sort(), [
    'calendarEvents.list', 'calendarEvents.list', 'claims.list', 'sessions.list',
  ], 'Retry reloads only the workflow group');
  assert.ok(workDown.textContent.includes('Appointments to match'),
    'the recovered workflow cards render in place');

  // Reporting fails, workflow survives.
  const reportDown = await mount(FULL, { failReport: true });
  assert.ok(reportDown.textContent.includes('Could not load your practice overview'),
    'a reporting failure shows its own inline error');
  assert.deepStrictEqual(labels(reportDown), [
    'Appointments to match', 'Sessions to confirm', 'Claims needing correction',
    'Claims to verify', 'Claims needing follow-up',
  ], 'the workflow cards stay visible and usable when reports fail');
  ['Claims tracked', 'Total billed', 'Outstanding billed'].forEach((label) => {
    assert.ok(!reportDown.textContent.includes(label),
      label + ' is absent on failure — never a fabricated 0 or $0');
  });
  const reportRetry = tagged(reportDown, 'BUTTON').find((b) => b.textContent === 'Retry');
  assert.ok(reportRetry, 'the reporting error offers Retry');
  calls = [];
  failReport = false;
  reportRetry.dispatch('click');
  await flush();
  assert.deepStrictEqual(calls.map((c) => c.name), ['reports.summary'],
    'Retry reloads only the reporting group');
  assert.ok(reportDown.textContent.includes('Claims tracked'),
    'the recovered reporting cards render in place');

  // === 17. the shared classifier, not a copy ================================

  assert.ok(/workflow\.buildCalendarWorkflow\(/.test(dashboardSrc),
    'the Dashboard calls the shared classifier');
  assert.ok(!/function buildWorkflow\s*\(|function buildCalendarWorkflow\s*\(/.test(dashboardSrc),
    'the Dashboard carries no copy of the classification rules');

  console.log('PASS dashboard_workflow_ui.test.js');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
