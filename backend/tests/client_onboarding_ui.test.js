'use strict';

// Unit test — client creation, the onboarding chain, and the chart's setup
// checklist (public/app/views/clients.js).
//
// Two properties this pins, both of which are about a client with NOTHING set:
//
// 1. EXISTING-CLIENT COMPATIBILITY. Every per-client billing default is
//    nullable with no DB default, so every row that existed before migration
//    021 has five nulls. Such a client must behave EXACTLY as it did before the
//    feature existed: no validation failure, no "undefined" rendered anywhere,
//    no accidental zero fee, no fallback billing data invented from nowhere.
//    The zero case matters most — a truthiness test rather than a null test
//    would turn "no default fee" into "bill nothing", and turn a deliberate
//    free session into "bill the client's default rate".
//
// 2. ONBOARDING IS SKIPPABLE AND RESUMABLE. The client is created by its own
//    committed request BEFORE the chain starts, so creation is never contingent
//    on finishing the billing steps. Dismissing any step leaves the client
//    intact, and the chart's "Finish setting up" checklist is the way back into
//    whatever was skipped.
//
// clients.js is a browser IIFE, so it is evaluated against a minimal fake DOM
// and a fake window.Reddably kit whose api is a recording stub. Fixtures are
// synthetic — no PHI.
//
//   node backend/tests/client_onboarding_ui.test.js

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

// --- fixtures ----------------------------------------------------------------

const CLIENT_ID = 'c-1';

// A client as it exists on a database that has had migration 021 applied but has
// never had a default set — i.e. EVERY row that predates the feature. All five
// default columns are null, exactly as `add column if not exists <name> <type>`
// leaves them (nullable, no DB default, no backfill).
function legacyClient(over) {
  return Object.assign({
    id: CLIENT_ID,
    practice_id: 'p-1',
    first_name: 'Legacy',
    last_name: 'Client',
    status: 'active',
    phone: '+13035550123',
    date_of_birth: '1990-01-01',
    gender: 'female',
    address_line1: '1 Main St',
    city: 'Denver',
    state: 'CO',
    postal_code: '80202',
    diagnosis_codes: null,
    default_cpt_code: null,
    default_place_of_service: null,
    default_session_fee: null,
    default_procedure_modifiers: null,
    calendar_display_name: null,
    payment_method_last4: '4242',      // billing already resolved
    payment_method_brand: 'visa',
  }, over || {});
}

function policy(over) {
  return Object.assign({
    id: 'ins-1',
    client_id: CLIENT_ID,
    carrier_name: 'Aetna',
    member_id: 'W1',
    payer_id: '60054',
    is_primary: true,
    is_hidden: false,
    benefits_checked_at: '2026-08-01T00:00:00.000Z',
    benefits_summary: { active: true },
  }, over || {});
}

// --- recording stubs ----------------------------------------------------------

const calls = [];
const toasts = [];
let currentClient = legacyClient();
let currentInsurance = [policy()];
let createdClient = null;
// Queue of values each successive formModal call resolves with. `null` = the
// user dismissed that step.
let formQueue = [];
let confirmQueue = [];

const api = {
  clients: {
    get(id) { calls.push({ name: 'clients.get', id }); return Promise.resolve({ client: currentClient }); },
    list() { calls.push({ name: 'clients.list' }); return Promise.resolve({ clients: [currentClient] }); },
    create(payload) {
      calls.push({ name: 'clients.create', payload });
      createdClient = legacyClient({ id: 'c-new', first_name: 'Brand', last_name: 'New' });
      return Promise.resolve({ client: createdClient });
    },
    update(id, payload) { calls.push({ name: 'clients.update', id, payload }); return Promise.resolve({ client: currentClient }); },
    sendPaymentLink(id) { calls.push({ name: 'clients.sendPaymentLink', id }); return Promise.resolve({ ok: true }); },
  },
  insuranceRecords: {
    list() { return Promise.resolve({ insurance_records: currentInsurance }); },
    update() { return Promise.resolve({}); },
  },
  sessions: { list() { return Promise.resolve({ sessions: [] }); } },
  users: { list() { return Promise.resolve({ users: [] }); } },
  calendarEvents: {
    list() { calls.push({ name: 'calendarEvents.list' }); return Promise.resolve({ calendar_events: [] }); },
    promote(id, clientId) { calls.push({ name: 'calendarEvents.promote', id, clientId }); return Promise.resolve({}); },
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
  renderEmpty(root, opts) {
    clear(root);
    const btn = h('button', { class: 'btn', onClick: opts.onAction }, opts.actionLabel || 'Action');
    root.appendChild(h('div', { class: 'empty-state' }, [opts.title, btn]));
  },
  fmtDate(s) { return s ? String(s).slice(0, 10) : '—'; },
  fmtMoney(v) { return v == null ? '—' : '$' + v; },
  statusBadge(status) { return h('span', { class: 'badge badge--neutral' }, status); },
  toast(message, tone, dwell) { toasts.push({ message, tone, dwell }); },
  navigate() {},
  confirmModal() {
    return Promise.resolve(confirmQueue.length ? confirmQueue.shift() : false);
  },
  formModal(opts) {
    calls.push({ name: 'formModal', title: opts.title, fields: (opts.fields || []).map((f) => f.name) });
    return Promise.resolve(formQueue.length ? formQueue.shift() : null);
  },
  registerView(name, fn) { if (name === 'clients') viewFn = fn; },
};

const APP = path.join(__dirname, '..', '..', 'public', 'app');
const context = vm.createContext({
  window: {
    Reddably,
    ReddablyDiagnoses: { label(c) { return c; } },
    ReddablyPhone: { normalize(v) { return { ok: true, value: v }; } },
    ReddablyPlan: { state: { loaded: true }, get() { return 'founder'; } },
    location: { hash: '' },
  },
  document: fakeDocument,
  console,
  Promise,
  Date,
});
vm.runInContext(fs.readFileSync(path.join(APP, 'client-defaults.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(APP, 'views', 'clients.js'), 'utf8'), context);
assert.ok(typeof viewFn === 'function', 'clients.js registers the clients view');

function flush() {
  return new Promise((resolve) => setImmediate(() => setImmediate(() =>
    setImmediate(() => setImmediate(() => setImmediate(resolve))))));
}

function reset() {
  calls.length = 0;
  toasts.length = 0;
  currentClient = legacyClient();
  currentInsurance = [policy()];
  createdClient = null;
  formQueue = [];
  confirmQueue = [];
}

async function chart(clientOver, insurance) {
  currentClient = legacyClient(clientOver);
  if (insurance !== undefined) currentInsurance = insurance;
  const root = createElement('div');
  viewFn(root, [CLIENT_ID]);
  await flush();
  return root;
}

async function clientList() {
  const root = createElement('div');
  viewFn(root, []);
  await flush();
  return root;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- 1. existing-client compatibility ----------------------------------------

test('a client with no defaults renders with no "undefined" anywhere', async () => {
  const root = await chart();
  assert.ok(!/undefined/.test(root.textContent),
    'a null default must never reach the page as the string "undefined"');
  assert.ok(!/null/.test(root.textContent),
    'nor as the string "null"');
});

test('a client with no defaults shows the defaults item as outstanding', async () => {
  const root = await chart();
  assert.ok(/Finish setting up/.test(root.textContent), 'the checklist is shown');
  assert.ok(/Set claim defaults/.test(root.textContent),
    'the unset defaults are named as outstanding work, not silently assumed');
  // And it explains the consequence rather than just listing a chore.
  assert.ok(/no CPT code, place of service or fee/i.test(root.textContent));
});

test('a client WITH defaults set drops that checklist item', async () => {
  const root = await chart({ default_cpt_code: '90837' });
  assert.ok(!/Set claim defaults/.test(root.textContent),
    'a resolved item disappears — a checklist of ticks is a nag, not information');
});

test('a zero default fee counts as SET, not as absent', async () => {
  // The bug a truthiness test would introduce: a genuinely free session is a
  // real default, and the checklist must not nag for it forever.
  const root = await chart({ default_session_fee: 0 });
  assert.ok(!/Set claim defaults/.test(root.textContent),
    'a 0 fee is a deliberate value, not an unset one');
});

test('the checklist vanishes entirely once nothing is outstanding', async () => {
  const root = await chart({ default_cpt_code: '90837' });
  assert.ok(!/Finish setting up/.test(root.textContent),
    'card + insurance + defaults all present → no card at all');
});

test('a client with nothing set at all lists every outstanding item', async () => {
  const root = await chart(
    { payment_method_last4: null, payment_method_brand: null },
    []
  );
  assert.ok(/Save a card for the per-claim fee/.test(root.textContent));
  assert.ok(/Add an insurance policy/.test(root.textContent));
  assert.ok(/Set claim defaults/.test(root.textContent));
  assert.ok(/3 items left/.test(root.textContent), 'the count is honest');
});

// --- 2. onboarding is skippable and resumable --------------------------------

test('the client is created by its own request BEFORE any onboarding step runs', async () => {
  reset();
  const root = await clientList();
  // Empty-state path is not in play (one client exists), so use the header action.
  const newBtn = byLabel(root, 'New client');
  assert.ok(newBtn, 'the New client action exists');

  formQueue = [{ first_name: 'Brand', last_name: 'New', gender: 'unknown' }];
  confirmQueue = [false];   // decline the payment link
  newBtn.dispatch('click');
  await flush();

  const created = calls.filter((c) => c.name === 'clients.create');
  assert.strictEqual(created.length, 1, 'exactly one create request');

  // The create request carries NO billing defaults — they are a later, separate,
  // skippable step, so creation can never fail on them.
  const payloadKeys = Object.keys(created[0].payload);
  assert.ok(!payloadKeys.some((k) => k.indexOf('default_') === 0),
    'client creation is not contingent on any billing default');
});

test('dismissing every onboarding step leaves the created client intact', async () => {
  reset();
  const root = await clientList();
  formQueue = [
    { first_name: 'Brand', last_name: 'New', gender: 'unknown' },  // the create form
    null,                                                          // defaults: dismissed
  ];
  confirmQueue = [false];                                          // payment link: declined
  byLabel(root, 'New client').dispatch('click');
  await flush();

  assert.strictEqual(calls.filter((c) => c.name === 'clients.create').length, 1,
    'the client was created');
  assert.ok(!calls.some((c) => c.name === 'clients.update'),
    'and nothing tried to patch it afterwards');
  assert.ok(!calls.some((c) => c.name === 'clients.sendPaymentLink'),
    'the declined step did not fire');
  assert.ok(!toasts.some((t) => t.tone === 'error'),
    'skipping is not an error condition');
});

test('the defaults step runs AFTER the payment link and BEFORE calendar matching', async () => {
  reset();
  const root = await clientList();
  formQueue = [
    { first_name: 'Brand', last_name: 'New', gender: 'unknown' },
    { default_cpt_code: '90837' },
  ];
  confirmQueue = [true];    // send the link
  byLabel(root, 'New client').dispatch('click');
  await flush();

  const order = calls
    .filter((c) => ['clients.create', 'clients.sendPaymentLink', 'clients.update', 'calendarEvents.list'].indexOf(c.name) !== -1)
    .map((c) => c.name);

  assert.deepStrictEqual(order,
    ['clients.create', 'clients.sendPaymentLink', 'clients.update', 'calendarEvents.list'],
    'defaults are saved before the calendar step, so a matched appointment is seeded from them');
});

test('a failed payment-link send does not abort the rest of onboarding', async () => {
  reset();
  const root = await clientList();
  const original = api.clients.sendPaymentLink;
  api.clients.sendPaymentLink = (id) => {
    calls.push({ name: 'clients.sendPaymentLink', id });
    return Promise.reject(new Error('Twilio unavailable'));
  };
  formQueue = [
    { first_name: 'Brand', last_name: 'New', gender: 'unknown' },
    { default_cpt_code: '90837' },
  ];
  confirmQueue = [true];
  byLabel(root, 'New client').dispatch('click');
  await flush();
  api.clients.sendPaymentLink = original;

  assert.ok(calls.some((c) => c.name === 'clients.update'),
    'the defaults step still ran after the send failed');
  assert.ok(toasts.some((t) => t.tone === 'error'), 'and the failure was reported');
});

test('the checklist is the way back into the skipped defaults step', async () => {
  reset();
  const root = await chart();   // no defaults set
  const button = byLabel(root, 'Set defaults');
  assert.ok(button, 'the checklist offers the action');

  formQueue = [{ default_cpt_code: '90837', default_session_fee: 175 }];
  button.dispatch('click');
  await flush();

  const update = calls.find((c) => c.name === 'clients.update');
  assert.ok(update, 'it reopens the same step and saves');
  assert.deepStrictEqual(Object.keys(update.payload).sort(),
    ['default_cpt_code', 'default_session_fee']);
});

test('the checklist offers no payment-link button without a phone', async () => {
  const root = await chart({
    payment_method_last4: null, payment_method_brand: null, phone: null,
  });
  assert.ok(/Save a card for the per-claim fee/.test(root.textContent), 'still listed');
  assert.ok(/Add a phone number first/.test(root.textContent), 'the prerequisite is named');
  assert.strictEqual(byLabel(root, 'Send payment link'), null,
    'no dead-end button: the endpoint 400s without a phone');
});

// --- runner -------------------------------------------------------------------

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      reset();
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
