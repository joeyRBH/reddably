'use strict';

// CHARACTERIZATION test — the Edit-claim write lifecycle in
// public/app/views/claims.js (doEditClaim).
//
// This pins behaviour that is PRE-EXISTING and, in one respect, WRONG. It is
// deliberately not fixed here.
//
// doEditClaim performs two writes in sequence:
//
//     api.sessions.update(session.id, payload)      <- the real edit
//       .then(() => api.claims.regenerate(claim.id))  <- recompute billed_amount
//
// and both share ONE .catch. So when the session write SUCCEEDS and regenerate
// FAILS, the user sees a bare error toast and load() never runs — the screen
// keeps showing the old values even though the session write landed and the
// claim's billed_amount is now stale against it. It reads as "nothing changed"
// when something did.
//
// That is not a defect introduced by per-client billing defaults; it predates
// them (it dates to the shared-readiness/split-workspace change) and is being
// corrected as its own scoped change. Pinning it here means:
//
//   * the current behaviour is documented and intentional-until-fixed rather
//     than accidental, and
//   * the defaults work layered on top provably did NOT alter it — the defaults
//     write is strictly secondary and its failure is caught inside
//     submitWithDefaults, so it can never reach this .catch.
//
// WHEN THE FIX LANDS, THIS TEST SHOULD FAIL. That is the point. Update it then
// to assert the truthful messaging (the session write is reported as having
// succeeded, and the view reloads) rather than deleting it.
//
// claims.js is a browser IIFE, so it is evaluated against a minimal fake DOM and
// a fake window.Reddably kit whose api is a recording stub — no jsdom, no
// network, no real DB. Fixtures are synthetic — no PHI.
//
//   node backend/tests/claims_regenerate_lifecycle.test.js

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
    appendChild(child) { child.parentNode = el; el.childNodes.push(child); return child; },
    removeChild(child) {
      const i = el.childNodes.indexOf(child);
      if (i !== -1) el.childNodes.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    setAttribute(name, value) {
      el.attributes[name] = String(value);
      if (name === 'value') el.value = String(value);
      if (name === 'disabled') el.disabled = true;
    },
    addEventListener(type, fn) { (el.listeners[type] || (el.listeners[type] = [])).push(fn); },
    dispatch(type, arg) { (el.listeners[type] || []).forEach((fn) => fn(arg || { target: el })); },
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

function byLabel(root, label) {
  return walk(root).filter((el) => el.tagName === 'BUTTON')
    .find((b) => b.textContent === label) || null;
}

// --- fixtures + recording stubs ----------------------------------------------

const CLAIM_ID = 'claim-1';
const SESSION_ID = 'session-1';
const CLIENT_ID = 'client-1';

const claim = {
  id: CLAIM_ID,
  session_id: SESSION_ID,
  client_id: CLIENT_ID,
  client_name: 'Test Client',
  status: 'draft',
  billed_amount: 200,
  session_date: '2026-08-01',
  cpt_code: '90837',
  diagnosis_codes: ['F411'],
};

const session = {
  id: SESSION_ID,
  client_id: CLIENT_ID,
  session_date: '2026-08-01',
  cpt_code: '90837',
  diagnosis_codes: ['F411'],
  fee: 200,
};

const calls = [];
const toasts = [];
let regenerateBehaviour = () => Promise.resolve({});
let sessionUpdateBehaviour = () => Promise.resolve({});
let clientUpdateBehaviour = () => Promise.resolve({ client: {} });
// What the Edit-claim form "returns" when submitted.
let formValues = null;
// Whether the user ticked the save-as-defaults box.
let tickDefaults = false;

const api = {
  claims: {
    get(id) { calls.push({ name: 'claims.get', id }); return Promise.resolve({ claim }); },
    events() { return Promise.resolve({ claim_events: [] }); },
    regenerate(id) { calls.push({ name: 'claims.regenerate', id }); return regenerateBehaviour(); },
    list() { return Promise.resolve({ claims: [] }); },
  },
  sessions: {
    get(id) { calls.push({ name: 'sessions.get', id }); return Promise.resolve({ session }); },
    update(id, payload) {
      calls.push({ name: 'sessions.update', id, payload });
      return sessionUpdateBehaviour();
    },
  },
  clients: {
    get(id) { calls.push({ name: 'clients.get', id }); return Promise.resolve({ client: { id: CLIENT_ID, first_name: 'Test', last_name: 'Client' } }); },
    list() { return Promise.resolve({ clients: [] }); },
    update(id, payload) {
      calls.push({ name: 'clients.update', id, payload });
      return clientUpdateBehaviour();
    },
  },
};

function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

let viewFn = null;
const Reddably = {
  h,
  api,
  clear,
  currentUser() { return { role: 'practice_admin' }; },
  renderLoading(root) { clear(root); root.appendChild(h('div', { class: 'skeleton' })); },
  renderError(root, err) { clear(root); root.appendChild(h('div', { class: 'inline-error' }, String(err && err.message))); },
  renderEmpty(root, opts) { clear(root); root.appendChild(h('div', { class: 'empty-state' }, opts.title)); },
  fmtDate(s) { return s ? String(s).slice(0, 10) : '—'; },
  fmtMoney(v) { return v == null ? '—' : '$' + v; },
  statusBadge(status) { return h('span', { class: 'badge badge--neutral' }, status); },
  toast(message, tone, dwell) { toasts.push({ message, tone, dwell }); },
  navigate() {},
  confirmModal() { return Promise.resolve(false); },
  // Fire any uiOnly checkbox's onToggle so the "save as defaults" instruction can
  // be simulated, then resolve with the form's values.
  formModal(opts) {
    (opts.fields || []).forEach((f) => {
      if (f.type === 'checkbox' && typeof f.onToggle === 'function') f.onToggle(tickDefaults);
    });
    return Promise.resolve(formValues);
  },
  registerView(name, fn) { if (name === 'claims') viewFn = fn; },
};

// client-defaults.js must load first — views/claims.js calls into it.
const APP = path.join(__dirname, '..', '..', 'public', 'app');
const sandbox = {
  window: {
    Reddably,
    ReddablyDiagnoses: { label(c) { return c; } },
    ReddablyPlan: { state: { loaded: true }, get() { return 'founder'; } },
    location: { hash: '' },
  },
  document: fakeDocument,
  console,
  Promise,
  Date,
};
const context = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(APP, 'client-defaults.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(APP, 'views', 'claims.js'), 'utf8'), context);

assert.ok(typeof viewFn === 'function', 'claims.js registers the claims view');

function flush() {
  return new Promise((resolve) => setImmediate(() => setImmediate(() =>
    setImmediate(() => setImmediate(resolve)))));
}

function reset() {
  calls.length = 0;
  toasts.length = 0;
  regenerateBehaviour = () => Promise.resolve({});
  sessionUpdateBehaviour = () => Promise.resolve({});
  clientUpdateBehaviour = () => Promise.resolve({ client: {} });
  tickDefaults = false;
  formValues = {
    session_date: '2026-08-02',
    cpt_code: '90834',
    diagnosis_codes: 'F411',
    fee: 150,
  };
}

// Render the claim detail and click through "Edit claim".
async function editClaim() {
  const root = createElement('div');
  viewFn(root, [CLAIM_ID]);
  await flush();
  const button = byLabel(root, 'Edit claim');
  assert.ok(button, 'the Edit claim action is present on a draft claim');
  button.dispatch('click');
  await flush();
  return root;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- 1. the happy path -------------------------------------------------------

test('both writes succeed: success toast and the view reloads', async () => {
  reset();
  await editClaim();

  const names = calls.map((c) => c.name);
  assert.ok(names.indexOf('sessions.update') !== -1, 'the session is written');
  assert.ok(names.indexOf('claims.regenerate') !== -1, 'the claim is regenerated');
  assert.ok(names.indexOf('sessions.update') < names.indexOf('claims.regenerate'),
    'the session write happens first');

  assert.strictEqual(toasts.length, 1);
  assert.strictEqual(toasts[0].tone, 'success');
  // load() re-fetches the claim: one fetch on mount, one after the edit.
  assert.ok(calls.filter((c) => c.name === 'claims.get').length >= 2,
    'the view reloads after a successful edit');
});

// --- 2. THE PRE-EXISTING DEFECT, pinned --------------------------------------

test('CHARACTERIZATION: session write succeeds, regenerate fails — reads as total failure', async () => {
  reset();
  regenerateBehaviour = () => Promise.reject(new Error('Could not regenerate the claim.'));
  const reloadsBefore = 1; // the mount fetch
  await editClaim();

  // The session write DID land.
  const updates = calls.filter((c) => c.name === 'sessions.update');
  assert.strictEqual(updates.length, 1, 'the session was written');

  // ...and yet the user is told only that something errored.
  assert.strictEqual(toasts.length, 1, 'exactly one message');
  assert.strictEqual(toasts[0].tone, 'error');
  assert.strictEqual(toasts[0].message, 'Could not regenerate the claim.');
  assert.ok(!/updated|saved/i.test(toasts[0].message),
    'nothing tells the user the session edit actually succeeded');

  // ...and the screen is never refreshed, so it still shows the OLD values while
  // the saved session now holds the new ones. THIS IS THE DEFECT.
  const reloads = calls.filter((c) => c.name === 'claims.get').length;
  assert.strictEqual(reloads, reloadsBefore,
    'load() never runs — the view keeps showing stale values after a landed write');
});

test('CHARACTERIZATION: the session write is NOT rolled back when regenerate fails', async () => {
  reset();
  regenerateBehaviour = () => Promise.reject(new Error('boom'));
  await editClaim();

  // There is no compensating write of any kind — nothing restores the session.
  const writes = calls.filter((c) => c.name === 'sessions.update');
  assert.strictEqual(writes.length, 1,
    'exactly one session write, and no second write undoing it');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(writes[0].payload)), {
    session_date: '2026-08-02',
    cpt_code: '90834',
    fee: 150,
    diagnosis_codes: ['F411'],
  }, 'the new values stand');
});

// --- 3. the defaults work did not change any of the above --------------------

test('a DEFAULTS failure is isolated: it never reaches the claim error path', async () => {
  reset();
  tickDefaults = true;
  clientUpdateBehaviour = () => Promise.reject(new Error('network'));
  await editClaim();

  assert.ok(calls.some((c) => c.name === 'clients.update'), 'the defaults write was attempted');

  // A warning, not an error — and crucially not the bare error toast the
  // regenerate path produces, which is what would happen if the defaults failure
  // escaped into the shared .catch.
  assert.strictEqual(toasts.length, 1);
  assert.strictEqual(toasts[0].tone, 'warn');
  assert.ok(/could not be saved/i.test(toasts[0].message));
  assert.ok(!toasts.some((t) => t.tone === 'error'),
    'a defaults failure must never be reported as a failed claim edit');

  // And unlike the regenerate failure, the view DOES reload here.
  assert.ok(calls.filter((c) => c.name === 'claims.get').length >= 2,
    'the screen still refreshes, so it corroborates the warning');
});

test('the defaults request carries only the fields Edit claim exposes', async () => {
  reset();
  tickDefaults = true;
  await editClaim();

  const update = calls.find((c) => c.name === 'clients.update');
  assert.ok(update, 'the defaults write happened');
  assert.strictEqual(update.id, CLIENT_ID, 'against this claim\'s client');
  assert.deepStrictEqual(Object.keys(update.payload).sort(),
    ['default_cpt_code', 'default_session_fee', 'diagnosis_codes'],
    'dx / CPT / fee only — place of service and modifiers are not on this form');
});

test('unticked, nothing is written to the client at all', async () => {
  reset();
  await editClaim();
  assert.ok(!calls.some((c) => c.name === 'clients.update'),
    'the box is an explicit instruction; without it the chart is untouched');
});

// --- runner -------------------------------------------------------------------

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log('  ok  ' + t.name);
    } catch (err) {
      failed++;
      console.error('FAIL  ' + t.name + '\n      ' + (err && err.message));
    }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
