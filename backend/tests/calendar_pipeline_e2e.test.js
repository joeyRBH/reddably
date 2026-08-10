'use strict';

// End-to-end verification of the two-stage calendar pipeline.
//
//   Appointments needing a client --(Match client)--> Sessions to confirm
//     --(Confirm session)--> cleared
//
// Drives the REAL views (public/app/views/calendar.js + dashboard.js) and the
// REAL shared classifier (public/app/workflow.js) against a fake DOM and an
// in-memory server that mirrors the actual Lambda handlers:
//
//   * POST /calendar-events/{id}/promote  (backend/handlers/calendar_events.js)
//       -> match_state 'confirmed', session_id set, session inserted 'scheduled'
//   * PATCH /sessions/{id} {status:'completed'} (backend/handlers/sessions.js)
//       -> creates the draft claim, advances the session to 'claim_ready'
//   * GET /calendar-events default -> match_state in (unmatched, matched)
//     GET /calendar-events?state=confirmed -> match_state = 'confirmed'
//     GET /sessions?status=scheduled       -> sessions with that status
//
// Three appointments run the gauntlet together so the fix and the control
// travel side by side:
//   A  all-day, past      (ends_at NULL)  <- the case that used to skip
//   B  timed,   past                      <- must behave exactly as before
//   C  timed,   future                    <- must stay upcoming throughout
//
// Complements the two unit tests rather than repeating them:
// calendar_workflow.test.js pins the classifier's rules and
// dashboard_workflow_ui.test.js pins the counts, but neither walks an
// appointment through BOTH stage transitions against a server that actually
// mutates state. This is the only test that would catch a regression where an
// appointment leaves one tab without arriving in the next.
//
// The clock is frozen (FrozenDate) so the file can never rot into a wall-clock
// dependent failure the way dashboard_workflow_ui.test.js once did.
//
// Synthetic ids and placeholder titles only — no PHI.
//
//   node backend/tests/calendar_pipeline_e2e.test.js

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const P = (...p) => path.join(ROOT, 'public', 'app', ...p);

// --- fake DOM ----------------------------------------------------------------

function textNode(value) {
  return { nodeType: 3, textContent: String(value), childNodes: [] };
}

function createElement(tag) {
  const el = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    className: '', attributes: {}, dataset: {}, childNodes: [], listeners: {},
    parentNode: null, disabled: false, value: '',
    appendChild(c) { c.parentNode = el; el.childNodes.push(c); return c; },
    removeChild(c) {
      const i = el.childNodes.indexOf(c);
      if (i !== -1) el.childNodes.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    setAttribute(n, v) { el.attributes[n] = String(v); if (n === 'disabled') el.disabled = true; },
    addEventListener(t, fn) { (el.listeners[t] || (el.listeners[t] = [])).push(fn); },
    dispatch(t, arg) { (el.listeners[t] || []).forEach((fn) => fn(arg || { target: el })); },
    get firstChild() { return el.childNodes[0]; },
  };
  Object.defineProperty(el, 'textContent', {
    get() { return el.childNodes.map((c) => c.textContent).join(''); },
    set(v) { el.childNodes = [textNode(v)]; },
  });
  return el;
}

const fakeDocument = { createElement, createTextNode: textNode };

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
  if (Array.isArray(children)) { children.forEach((c) => append(el, c)); return; }
  el.appendChild(children.nodeType ? children : textNode(children));
}

function walk(node, out) {
  out = out || [];
  (node.childNodes || []).forEach((c) => {
    if (c.nodeType === 1) { out.push(c); walk(c, out); }
  });
  return out;
}

const tagged = (n, t) => walk(n).filter((el) => el.tagName === t);

function section(root, title) {
  const card = walk(root).find(
    (el) => el.className === 'card' &&
      walk(el).some((c) => c.className === 'card__title' && c.textContent === title)
  );
  assert.ok(card, 'section "' + title + '" is rendered');
  return card;
}

// The <tr> in `card` for appointment `id`, or null.
function rowFor(card, id) {
  return tagged(card, 'TR').find((tr) => tr.textContent.includes('Appointment ' + id)) || null;
}

const has = (card, id) => rowFor(card, id) !== null;

// Dashboard stat cards.
const statCards = (root) => walk(root).filter((el) => el.className === 'card stat');
function statLabel(c) {
  const l = walk(c).find((el) => el.className === 'stat__label');
  return l ? l.textContent : null;
}
// Attention cards render only when the count is non-zero (dashboard.js:
// `if (n.toConfirm) cards.push(...)`), so an ABSENT card is a zero.
function statValue(root, label) {
  const card = statCards(root).find((c) => statLabel(c) === label);
  if (!card) return '0';
  const v = walk(card).find((el) => el.className === 'stat__value');
  return v ? v.textContent : null;
}

// --- frozen clock ------------------------------------------------------------

const NOW = Date.parse('2026-07-28T18:00:00Z');
const T = (iso) => new Date(iso).toISOString();

class FrozenDate extends Date {
  constructor(...args) { if (args.length === 0) super(NOW); else super(...args); }
  static now() { return NOW; }
}

// --- in-memory server (mirrors the real handlers) ----------------------------

const CLIENT = { id: 'c-1', first_name: 'Client', last_name: 'One', status: 'active' };

let events, sessions, seq;

function reset() {
  seq = 0;
  sessions = [];
  events = [
    // A — all-day, already ENDED, no end time at all. The regression case.
    {
      id: 'A', summary_raw: 'Appointment A', starts_at: T('2026-07-26T00:00:00Z'),
      ends_at: null, duration_minutes: null, event_status: 'confirmed',
      match_state: 'matched', matched_client_id: 'c-1', matched_client_name: 'Client One',
      match_confidence: 91, session_id: null,
    },
    // B — ordinary timed appointment, already ended. The control.
    {
      id: 'B', summary_raw: 'Appointment B', starts_at: T('2026-07-28T14:00:00Z'),
      ends_at: T('2026-07-28T15:00:00Z'), duration_minutes: 50, event_status: 'confirmed',
      match_state: 'matched', matched_client_id: 'c-1', matched_client_name: 'Client One',
      match_confidence: 88, session_id: null,
    },
    // C — timed, still ahead. Must stay upcoming the whole way through.
    {
      id: 'C', summary_raw: 'Appointment C', starts_at: T('2026-07-30T14:00:00Z'),
      ends_at: T('2026-07-30T15:00:00Z'), duration_minutes: 50, event_status: 'confirmed',
      match_state: 'matched', matched_client_id: 'c-1', matched_client_name: 'Client One',
      match_confidence: 75, session_id: null,
    },
  ];
}

const copy = (o) => JSON.parse(JSON.stringify(o));

const server = {
  listEvents(state) {
    const match = state
      ? (e) => e.match_state === state
      : (e) => e.match_state === 'unmatched' || e.match_state === 'matched';
    return copy(events.filter((e) => e.event_status !== 'cancelled' && match(e)));
  },
  listSessions(status) {
    return copy(sessions.filter((s) => !status || s.status === status));
  },
  // POST /calendar-events/{id}/promote
  promote(id, clientId) {
    const ev = events.find((e) => e.id === id);
    assert.ok(ev, 'promote: event exists');
    assert.notStrictEqual(ev.event_status, 'cancelled', 'promote: not cancelled');
    if (ev.session_id) return { session: copy(sessions.find((s) => s.id === ev.session_id)), already_promoted: true };
    const session = {
      id: 's-' + (++seq), status: 'scheduled', client_id: clientId,
      session_date: String(ev.starts_at).slice(0, 10), source: 'calendar',
    };
    sessions.push(session);
    ev.match_state = 'confirmed';
    ev.matched_client_id = clientId;
    ev.session_id = session.id;
    ev.promoted_at = T('2026-07-28T18:00:00Z');
    return { session: copy(session), calendar_event: copy(ev) };
  },
  // PATCH /sessions/{id} { status: 'completed' } -> claim + 'claim_ready'
  updateSession(id, payload) {
    const s = sessions.find((x) => x.id === id);
    assert.ok(s, 'update: session exists');
    if (payload.status === 'completed') {
      s.status = 'claim_ready';
      return { session: copy(s), claim_created: true };
    }
    s.status = payload.status;
    return { session: copy(s), claim_created: false };
  },
};

// --- the kit -----------------------------------------------------------------

const toasts = [];
const views = {};

function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

const api = {
  calendarEvents: {
    list(f) { return Promise.resolve({ calendar_events: server.listEvents((f && f.state) || null) }); },
    promote(id, clientId) { return Promise.resolve(server.promote(id, clientId)); },
    ignore() { return Promise.resolve({ ignored: true }); },
    sync() { return Promise.resolve({ synced: true }); },
  },
  sessions: {
    list(f) { return Promise.resolve({ sessions: server.listSessions(f && f.status) }); },
    update(id, payload) { return Promise.resolve(server.updateSession(id, payload)); },
  },
  clients: { list() { return Promise.resolve({ clients: [CLIENT] }); } },
  claims: { list() { return Promise.resolve({ claims: [] }); } },
  reports: {
    summary() {
      return Promise.resolve({
        report: { claim_count: 0, total_billed: 0, total_reimbursed: 0, outstanding_billed: 0 },
      });
    },
  },
  calendarConnections: { calendars() { return Promise.reject(new Error('no connection')); } },
  me() { return Promise.resolve({ user: { first_name: 'Joey' } }); },
};

const Reddably = {
  h, api, clear,
  currentUser: { user: { first_name: 'Joey' } },
  renderLoading(root) { clear(root); root.appendChild(h('div', { class: 'skeleton' })); },
  renderError(root, err) { clear(root); root.appendChild(h('div', { class: 'inline-error' }, String(err && err.message))); },
  renderEmpty(root, opts) { clear(root); root.appendChild(h('div', { class: 'empty-state' }, opts && opts.title)); },
  fmtDate(s) { return s ? String(s).slice(0, 10) : '—'; },
  fmtMoney(v) { return v == null ? '—' : '$' + v; },
  statusBadge(s) { return h('span', { class: 'badge badge--neutral' }, s); },
  toast(message, kind) { toasts.push({ message, kind }); },
  navigate() {},
  registerView(name, fn) { views[name] = fn; },
};

const sandbox = {
  window: { Reddably, confirm: () => false, setTimeout },
  document: fakeDocument, console, Promise, Date: FrozenDate,
};

vm.runInNewContext(fs.readFileSync(P('workflow.js'), 'utf8'), sandbox);
vm.runInNewContext(fs.readFileSync(P('views', 'calendar.js'), 'utf8'), sandbox);
vm.runInNewContext(fs.readFileSync(P('views', 'dashboard.js'), 'utf8'), sandbox);
assert.ok(views.calendar && views.dashboard, 'both views registered');

const flush = () => new Promise((r) => setImmediate(() => setImmediate(() => setImmediate(() => setImmediate(r)))));

async function mount(which) {
  const root = createElement('div');
  views[which](root);
  await flush();
  return root;
}

// Snapshot of which tab each appointment sits in, plus the dashboard counts.
async function snapshot() {
  const cal = await mount('calendar');
  const dash = await mount('dashboard');
  const tabs = {
    needsClient: section(cal, 'Appointments needing a client'),
    toConfirm: section(cal, 'Sessions to confirm'),
    upcoming: section(cal, 'Upcoming appointments'),
  };
  const where = {};
  ['A', 'B', 'C'].forEach((id) => {
    const found = Object.keys(tabs).filter((k) => has(tabs[k], id));
    assert.ok(found.length <= 1, id + ' is in at most one tab (found: ' + found.join(', ') + ')');
    where[id] = found[0] || 'none';
  });
  // Rows actually listed in each tab (excluding the "no rows" placeholder).
  const rowsIn = (card) => tagged(card, 'TR')
    .filter((tr) => tr.textContent.includes('Appointment ')).length;

  const counts = {
    toMatch: statValue(dash, 'Appointments to match'),
    toConfirm: statValue(dash, 'Sessions to confirm'),
  };

  // The invariant that matters for this change: "Sessions to confirm" is the
  // shared classifier's awaiting bucket, so the Dashboard number and the tab's
  // row count are the SAME number by construction, at every stage.
  assert.strictEqual(counts.toConfirm, String(rowsIn(tabs.toConfirm)),
    'dashboard "Sessions to confirm" == rows in the Sessions to confirm tab');

  // "Appointments to match" is deliberately WIDER than the tab: dashboard.js
  // counts every unpromoted pending event, past or future, while the tab shows
  // only the ones that have ended (future ones live in Upcoming). Pinned so the
  // difference stays a known property rather than a surprise.
  const unpromotedUpcoming = tagged(tabs.upcoming, 'TR')
    .filter((tr) => tr.textContent.includes('Appointment ') && !tr.textContent.includes('Scheduled')).length;
  assert.strictEqual(counts.toMatch, String(rowsIn(tabs.needsClient) + unpromotedUpcoming),
    'dashboard "Appointments to match" == needs-a-client rows + unpromoted upcoming rows');

  return { where, cal, tabs, counts, rowsIn };
}

function clickIn(card, id, label) {
  const row = rowFor(card, id);
  assert.ok(row, 'row for ' + id + ' exists');
  const btn = tagged(row, 'BUTTON').find((b) => b.textContent === label);
  assert.ok(btn, '"' + label + '" button on row ' + id);
  btn.dispatch('click');
  return btn;
}

const line = (s) => console.log('  ' + s);

// --- the walk-through --------------------------------------------------------

(async function run() {
  reset();

  // ===== stage 0: everything starts unpromoted ==============================
  let s = await snapshot();
  console.log('\nstage 0 — after sync, nothing matched yet');
  line('A (all-day, past) : ' + s.where.A);
  line('B (timed,   past) : ' + s.where.B);
  line('C (timed, future) : ' + s.where.C);
  line('dashboard: to match=' + s.counts.toMatch + '  to confirm=' + s.counts.toConfirm);

  assert.strictEqual(s.where.A, 'needsClient', 'A starts in Appointments needing a client');
  assert.strictEqual(s.where.B, 'needsClient', 'B starts in Appointments needing a client');
  assert.strictEqual(s.where.C, 'upcoming', 'C is a future appointment');
  // 3, not 2: the dashboard's match count includes the future appointment C.
  assert.strictEqual(s.counts.toMatch, '3');
  assert.strictEqual(s.counts.toConfirm, '0');

  // ===== stage 1: the administrator matches a client ========================
  clickIn(s.tabs.needsClient, 'A', 'Match client');
  await flush();
  clickIn((await snapshot()).tabs.needsClient, 'B', 'Match client');
  await flush();

  // The server really did both halves of stage 1.
  ['A', 'B'].forEach((id) => {
    const ev = events.find((e) => e.id === id);
    assert.strictEqual(ev.match_state, 'confirmed', id + ': match_state flipped to confirmed');
    assert.ok(ev.session_id, id + ': session_id stamped');
    assert.strictEqual(sessions.find((x) => x.id === ev.session_id).status, 'scheduled',
      id + ': session created as scheduled');
  });

  s = await snapshot();
  console.log('\nstage 1 — administrator matched a client on A and B');
  line('A (all-day, past) : ' + s.where.A);
  line('B (timed,   past) : ' + s.where.B);
  line('C (timed, future) : ' + s.where.C);
  line('dashboard: to match=' + s.counts.toMatch + '  to confirm=' + s.counts.toConfirm);

  assert.strictEqual(s.where.A, 'toConfirm', 'A LEFT needs-a-client and ARRIVED in Sessions to confirm');
  assert.strictEqual(s.where.B, 'toConfirm', 'B moved the same way — unchanged behaviour');
  assert.strictEqual(s.where.C, 'upcoming', 'C is untouched');
  assert.strictEqual(s.counts.toMatch, '1', 'only the still-future C remains to match');
  assert.strictEqual(s.counts.toConfirm, '2');

  // ===== stage 2: confirm the sessions ======================================
  toasts.length = 0;
  clickIn(s.tabs.toConfirm, 'A', 'Confirm session');
  await flush();
  clickIn((await snapshot()).tabs.toConfirm, 'B', 'Confirm session');
  await flush();

  ['A', 'B'].forEach((id) => {
    const ev = events.find((e) => e.id === id);
    assert.strictEqual(sessions.find((x) => x.id === ev.session_id).status, 'claim_ready',
      id + ": session advanced to claim_ready");
  });
  assert.ok(toasts.every((t) => t.kind === 'success'), 'both confirmations succeeded');

  s = await snapshot();
  console.log('\nstage 2 — sessions confirmed');
  line('A (all-day, past) : ' + s.where.A);
  line('B (timed,   past) : ' + s.where.B);
  line('C (timed, future) : ' + s.where.C);
  line('dashboard: to match=' + s.counts.toMatch + '  to confirm=' + s.counts.toConfirm);

  assert.strictEqual(s.where.A, 'none', 'A cleared out of every tab');
  assert.strictEqual(s.where.B, 'none', 'B cleared out of every tab');
  assert.strictEqual(s.where.C, 'upcoming', 'C still upcoming, never disturbed');
  assert.strictEqual(s.counts.toMatch, '1', 'C is still unmatched');
  assert.strictEqual(s.counts.toConfirm, '0');

  // ===== the calendar-event row is retained, never deleted ==================
  assert.strictEqual(events.length, 3, 'no calendar-event row was deleted anywhere in the flow');

  // ===== C only becomes confirmable once it has actually ended ==============
  // Promote C while it is still in the future, then re-read the buckets: it must
  // sit in Upcoming as "Scheduled", NOT jump the queue into Sessions to confirm.
  server.promote('C', 'c-1');
  s = await snapshot();
  console.log('\ncontrol — C promoted early, still in the future');
  line('C (timed, future) : ' + s.where.C + '  (dashboard to confirm=' + s.counts.toConfirm + ')');
  assert.strictEqual(s.where.C, 'upcoming', 'a promoted future appointment waits in Upcoming');
  assert.ok(rowFor(s.tabs.upcoming, 'C').textContent.includes('Scheduled'),
    'and shows its scheduled state');
  assert.strictEqual(s.counts.toConfirm, '0', 'it is not confirmation work yet');

  console.log('\nPASS calendar_pipeline_e2e.test.js');
})().catch((err) => { console.error(err); process.exit(1); });
