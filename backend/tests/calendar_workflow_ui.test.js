'use strict';

// Unit test — Calendar view rendering + actions (public/app/views/calendar.js).
//
// Complements backend/tests/calendar_workflow.test.js (which pins the pure
// bucketing) by actually running the view. calendar.js is a browser IIFE, so it
// is evaluated against a minimal fake DOM and a fake window.Reddably kit whose
// api is a recording stub — no jsdom, no network, no real DB, in keeping with
// the hand-stubbed style of the other tests here.
//
// Covers:
//   * the view loads exactly the resources the workflow needs — the default
//     review queue, state=confirmed, state=ignored, and sessions
//     status=scheduled;
//   * "Confirm session" renders ONLY for an ended, calendar-linked scheduled
//     session, never for a future or in-progress appointment;
//   * clicking it calls sessions.update(session.id, { status: 'completed' }),
//     disables the button while the request is in flight, and reports the
//     server's claim_created verbatim;
//   * matching a client calls calendarEvents.promote(...) and never a delete —
//     the calendar-event row is retained and the view simply reloads;
//   * the visible matching label is "Match client", never a bare "Confirm";
//   * ignored appointments stay visible and can still be matched;
//   * re-rendering the same root does not duplicate rows or click handlers.
//
// Fixtures are synthetic ids and placeholder titles only — no PHI.
//
//   node backend/tests/calendar_workflow_ui.test.js

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

function buttons(node) {
  return walk(node).filter((el) => el.tagName === 'BUTTON');
}

function buttonLabels(node) {
  return buttons(node).map((b) => b.textContent);
}

function rows(node) {
  return walk(node).filter((el) => el.tagName === 'TR');
}

// The card whose .card__title reads `title`.
function section(root, title) {
  const card = walk(root).find(
    (el) => el.className === 'card' &&
      walk(el).some((c) => c.className === 'card__title' && c.textContent === title)
  );
  assert.ok(card, 'section "' + title + '" is rendered');
  return card;
}

// --- fixtures ----------------------------------------------------------------

const HOUR = 3600 * 1000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

function ev(id, overrides) {
  return Object.assign({
    id: id,
    summary_raw: 'Appointment ' + id,
    starts_at: iso(now - 2 * HOUR),
    ends_at: iso(now - HOUR),
    duration_minutes: 50,
    event_status: 'confirmed',
    match_state: 'unmatched',
    matched_client_id: null,
    matched_client_name: null,
    match_confidence: null,
    session_id: null,
  }, overrides);
}

const ENDED = ev('e-ended', {
  match_state: 'confirmed', session_id: 's-ended', matched_client_name: 'Client A',
});
const IN_PROGRESS = ev('e-in-progress', {
  match_state: 'confirmed', session_id: 's-in-progress', matched_client_name: 'Client B',
  starts_at: iso(now - 10 * 60 * 1000), ends_at: iso(now + 40 * 60 * 1000),
});
const FUTURE_PROMOTED = ev('e-future-promoted', {
  match_state: 'confirmed', session_id: 's-future', matched_client_name: 'Client C',
  starts_at: iso(now + 24 * HOUR), ends_at: iso(now + 25 * HOUR),
});
const PAST_SUGGESTED = ev('e-past-suggested', {
  match_state: 'matched', matched_client_id: 'c-1', matched_client_name: 'Client D',
  match_confidence: 88,
  starts_at: iso(now - 30 * HOUR), ends_at: iso(now - 29 * HOUR),
});
const FUTURE_UNMATCHED = ev('e-future-unmatched', {
  starts_at: iso(now + 3 * HOUR), ends_at: iso(now + 4 * HOUR),
});
const IGNORED = ev('e-ignored', {
  match_state: 'ignored', matched_client_id: 'c-2', matched_client_name: 'Client E',
  starts_at: iso(now - 50 * HOUR), ends_at: iso(now - 49 * HOUR),
});

const SESSIONS = [
  { id: 's-ended', status: 'scheduled', session_date: '2026-07-28' },
  { id: 's-in-progress', status: 'scheduled', session_date: '2026-07-28' },
  { id: 's-future', status: 'scheduled', session_date: '2026-07-29' },
  // Manually created, calendar-less: must never reach the confirm section.
  { id: 's-manual', status: 'scheduled', session_date: '2026-07-28' },
];

const CLIENTS = [
  { id: 'c-1', first_name: 'Client', last_name: 'D', status: 'active' },
  { id: 'c-2', first_name: 'Client', last_name: 'E', status: 'active' },
];

// --- recording api stub ------------------------------------------------------

const calls = [];
let claimCreated = true;

function record(name, args, value) {
  calls.push({ name: name, args: args });
  return Promise.resolve(value);
}

const api = {
  calendarEvents: {
    list(filters) {
      const state = (filters && filters.state) || null;
      const byState = {
        null: [PAST_SUGGESTED, FUTURE_UNMATCHED],
        confirmed: [ENDED, IN_PROGRESS, FUTURE_PROMOTED],
        ignored: [IGNORED],
      };
      return record('calendarEvents.list', [filters],
        { calendar_events: byState[state === null ? 'null' : state] });
    },
    promote(id, clientId) {
      return record('calendarEvents.promote', [id, clientId],
        { session: { id: 's-new', session_date: '2026-07-29' } });
    },
    ignore(id) { return record('calendarEvents.ignore', [id], { ignored: true }); },
    sync() { return record('calendarEvents.sync', [], { synced: true }); },
  },
  sessions: {
    list(filters) { return record('sessions.list', [filters], { sessions: SESSIONS }); },
    update(id, payload) {
      return record('sessions.update', [id, payload],
        { session: { id: id, status: 'claim_ready' }, claim_created: claimCreated });
    },
  },
  clients: {
    list() { return record('clients.list', [], { clients: CLIENTS }); },
  },
  calendarConnections: {
    calendars() { return Promise.reject(new Error('no connection')); },
  },
};

// --- fake window.Reddably kit ------------------------------------------------

const toasts = [];
let viewFn = null;

function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

const Reddably = {
  h: h,
  api: api,
  clear: clear,
  renderLoading(root) { clear(root); root.appendChild(h('div', { class: 'skeleton' })); },
  renderError(root, err) { clear(root); root.appendChild(h('div', { class: 'inline-error' }, String(err && err.message))); },
  fmtDate(s) { return String(s); },
  toast(message, kind) { toasts.push({ message: message, kind: kind }); },
  registerView(name, fn) { if (name === 'calendar') viewFn = fn; },
};

const fakeWindow = { Reddably: Reddably, confirm: () => false, setTimeout: setTimeout };

const sandbox = {
  window: fakeWindow, document: fakeDocument, console: console, Promise: Promise, Date: Date,
};

// The workflow bucketing is no longer part of the view: it is the shared
// classifier at public/app/workflow.js, which Dashboard reads too. Load the
// REAL module (not a stub) so this test still exercises the real rules.
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app', 'workflow.js'), 'utf8'),
  sandbox
);
assert.ok(Reddably.workflow && typeof Reddably.workflow.buildCalendarWorkflow === 'function',
  'workflow.js attaches buildCalendarWorkflow to the shared namespace');

vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app', 'views', 'calendar.js'), 'utf8'),
  sandbox
);

assert.ok(typeof viewFn === 'function', 'calendar.js registers the calendar view');

// Objects built inside the vm carry that context's Object.prototype, so
// deepStrictEqual would reject them on identity alone. Compare plain shapes.
function plain(v) {
  return JSON.parse(JSON.stringify(v === undefined ? null : v));
}

// Let the loader's promise chain settle.
function flush() {
  return new Promise((resolve) => setImmediate(() => setImmediate(() => setImmediate(resolve))));
}

// --- the tests ---------------------------------------------------------------

(async function run() {
  const root = createElement('div');
  viewFn(root);
  await flush();

  // 1. The view loads exactly the four workflow resources.
  const listFilters = calls.filter((c) => c.name === 'calendarEvents.list').map((c) => c.args[0]);
  assert.deepStrictEqual(listFilters.map(plain), [null, { state: 'confirmed' }, { state: 'ignored' }],
    'the review queue, confirmed events, and ignored events are each loaded');
  const sessionFilters = calls.filter((c) => c.name === 'sessions.list').map((c) => c.args[0]);
  assert.deepStrictEqual(sessionFilters.map(plain), [{ status: 'scheduled' }],
    "sessions are loaded with status 'scheduled'");

  // 2. Confirm session renders only in the awaiting section, for the one ended
  //    calendar-linked session.
  const awaiting = section(root, 'Sessions to confirm');
  const upcoming = section(root, 'Upcoming appointments');
  const matching = section(root, 'Appointments needing a client');
  const ignoredCard = section(root, 'Ignored appointments');

  assert.deepStrictEqual(buttonLabels(awaiting), ['Confirm session'],
    'exactly one confirmable session, with one dominant action');
  assert.strictEqual(
    buttonLabels(root).filter((l) => l === 'Confirm session').length, 1,
    'Confirm session appears nowhere else in the view'
  );

  // 3. Neither the in-progress nor the future appointment offers confirmation.
  const upcomingText = upcoming.textContent;
  assert.ok(upcomingText.includes('Appointment e-in-progress'), 'in-progress appointment is listed');
  assert.ok(upcomingText.includes('Appointment e-future-promoted'), 'future appointment is listed');
  assert.ok(!buttonLabels(upcoming).includes('Confirm session'),
    'a future or in-progress appointment never offers Confirm session');
  assert.ok(upcomingText.includes('Scheduled'),
    'an already-promoted upcoming appointment shows its scheduled state');

  // 4. Upcoming ordering is soonest-first; past matching is most-recent-first.
  const upcomingOrder = upcoming.textContent;
  assert.ok(
    upcomingOrder.indexOf('e-in-progress') < upcomingOrder.indexOf('e-future-unmatched') &&
    upcomingOrder.indexOf('e-future-unmatched') < upcomingOrder.indexOf('e-future-promoted'),
    'upcoming appointments render starts_at ascending'
  );

  // 5. The manual session is invisible here.
  assert.ok(!root.textContent.includes('s-manual'),
    'a scheduled session with no calendar event never renders');

  // 6. The matching label is "Match client" — never a bare "Confirm".
  assert.ok(buttonLabels(matching).includes('Match client'), 'past matching offers Match client');
  assert.ok(!buttonLabels(root).includes('Confirm'), 'no bare "Confirm" button anywhere');
  assert.ok(matching.textContent.includes('Appointment e-past-suggested'),
    'a past unpromoted appointment stays visible for matching');

  // 7. Ignored appointments stay visible and reversible.
  assert.ok(ignoredCard.textContent.includes('Appointment e-ignored'), 'ignored appointment is listed');
  assert.ok(buttonLabels(ignoredCard).includes('Match client'),
    'an ignored appointment can still be matched');
  assert.ok(!buttonLabels(ignoredCard).includes('Ignore'), 'already ignored — no repeat Ignore');

  // 8. Confirming calls sessions.update(session.id, { status: 'completed' }).
  const confirmBtn = buttons(awaiting)[0];
  calls.length = 0;
  toasts.length = 0;
  confirmBtn.dispatch('click');
  assert.strictEqual(confirmBtn.disabled, true, 'the action disables while in flight');
  const update = calls.find((c) => c.name === 'sessions.update');
  assert.ok(update, 'sessions.update was called');
  assert.deepStrictEqual(plain(update.args), ['s-ended', { status: 'completed' }],
    "confirming PATCHes the linked session to 'completed'");
  assert.ok(!calls.some((c) => /promote|ignore/.test(c.name)),
    'confirming a session touches no calendar-event endpoint');
  await flush();
  assert.deepStrictEqual(plain(toasts[0]),
    { message: 'Session confirmed — claim draft ready in Claims.', kind: 'success' },
    'a created draft claim is reported');

  // 9. When the server reports no new claim, the message says so.
  claimCreated = false;
  const awaiting2 = section(root, 'Sessions to confirm');
  toasts.length = 0;
  buttons(awaiting2)[0].dispatch('click');
  await flush();
  assert.deepStrictEqual(plain(toasts[0]), { message: 'Session confirmed.', kind: 'success' },
    'no new claim -> the plain confirmation message');
  claimCreated = true;

  // 10. Matching a client promotes; it is never a delete, and the row is
  //     re-derived by reloading rather than spliced out of the DOM.
  const matching2 = section(root, 'Appointments needing a client');
  const matchBtn = buttons(matching2).find((b) => b.textContent === 'Match client');
  calls.length = 0;
  matchBtn.dispatch('click');
  const promote = calls.find((c) => c.name === 'calendarEvents.promote');
  assert.ok(promote, 'calendarEvents.promote was called');
  assert.deepStrictEqual(plain(promote.args), ['e-past-suggested', 'c-1'],
    'promotion names the event and the chosen client');
  assert.ok(!calls.some((c) => /remove|delete|destroy/i.test(c.name)),
    'promotion is never implemented as a deletion');
  await flush();
  assert.ok(calls.some((c) => c.name === 'calendarEvents.list' && c.args[0] &&
    c.args[0].state === 'confirmed'), 'the view reloads so the retained event moves sections');

  // 11. Re-rendering the same root duplicates neither rows nor handlers.
  const beforeRows = rows(root).length;
  const beforeButtons = buttons(root).length;
  viewFn(root);
  await flush();
  assert.strictEqual(rows(root).length, beforeRows, 're-rendering does not duplicate rows');
  assert.strictEqual(buttons(root).length, beforeButtons, 're-rendering does not duplicate buttons');
  buttons(root).forEach((b) => {
    assert.ok((b.listeners.click || []).length <= 1, 'each button carries a single click handler');
  });

  const confirmAgain = buttons(section(root, 'Sessions to confirm'))[0];
  calls.length = 0;
  confirmAgain.dispatch('click');
  assert.strictEqual(calls.filter((c) => c.name === 'sessions.update').length, 1,
    'one click after a re-render sends exactly one update');

  console.log('PASS calendar_workflow_ui.test.js');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
