'use strict';

// Unit test — the "Save as default" confirm gate on the client chart
// (public/app/views/clients.js).
//
// The guarantee this pins down: a patient's intake does not make them billable.
// The backend stopped auto-promoting (backend/handlers/card_setup.js writes no
// status), and the chart offers a clinician one explicit confirm instead. Covers:
//
//   * the review banner appears ONLY for an 'awaiting_info' client whose intake
//     left everything a claim needs on the chart;
//   * it is absent when the patient is still missing something — including the
//     "can't find my insurer" escape hatch, which leaves payer_id null — so a
//     half-finished submission is never presented as confirmable;
//   * it is absent for clients the practice already decided about (active,
//     inactive), so confirming is a one-time act, not a recurring nag;
//   * clicking it sends exactly PATCH /clients/{id} { status: 'active' } — the
//     ordinary authenticated status change, no dedicated endpoint — and reloads;
//   * the banner's readiness rule MIRRORS intakeCompleteness in
//     backend/handlers/card_setup.js (demographics + carrier + member id + a
//     routable payer id), asserted case by case;
//   * design: the confirm is the primary stone/ink action (.btn--primary), never
//     sage and never danger, and the banner uses tokens rather than raw hex.
//
// clients.js is a browser IIFE, so it is evaluated against a minimal fake DOM and
// a fake window.Reddably kit whose api is a recording stub — no jsdom, no
// network, no real DB, matching the hand-stubbed style of the other UI tests
// here. Fixtures are synthetic ids and placeholder names — no PHI.
//
//   node backend/tests/intake_confirm_ui.test.js

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
      if (name === 'value') el.value = String(value);
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

// The confirm button, wherever it lives on the page — null when absent.
function confirmButton(root) {
  return buttons(root).find((b) => b.textContent === 'Save as default') || null;
}

// --- fixtures ----------------------------------------------------------------

const CLIENT_ID = 'c-1';

// A client whose intake left everything a claim needs on the chart.
function client(over) {
  return Object.assign({
    id: CLIENT_ID,
    practice_id: 'p-1',
    first_name: 'Client',
    last_name: 'One',
    status: 'awaiting_info',
    date_of_birth: '1990-01-01',
    gender: 'female',
    address_line1: '1 Main St',
    city: 'Denver',
    state: 'CO',
    postal_code: '80202',
    diagnosis_codes: [],
  }, over || {});
}

function policy(over) {
  return Object.assign({
    id: 'ins-1',
    client_id: CLIENT_ID,
    carrier_name: 'Aetna',
    member_id: 'W123456789',
    payer_id: '60054',
    subscriber_relationship: 'self',
    is_primary: true,
    is_hidden: false,
  }, over || {});
}

// --- recording api stub ------------------------------------------------------

const calls = [];
let currentClient = client();
let currentInsurance = [policy()];

const api = {
  clients: {
    get(id) {
      calls.push({ name: 'clients.get', args: [id] });
      return Promise.resolve({ client: currentClient });
    },
    update(id, payload) {
      calls.push({ name: 'clients.update', args: [id, payload] });
      return Promise.resolve({ client: currentClient });
    },
    list() { return Promise.resolve({ clients: [] }); },
  },
  insuranceRecords: {
    list() { return Promise.resolve({ insurance_records: currentInsurance }); },
  },
  sessions: {
    list() { return Promise.resolve({ sessions: [] }); },
  },
  users: {
    list() { return Promise.resolve({ users: [] }); },
  },
};

// --- fake window.Reddably kit ------------------------------------------------

const toasts = [];

function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

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
  toast(message, tone) { toasts.push({ message, tone }); },
  navigate() {},
  confirmModal() { return Promise.resolve(false); },
  formModal() { return Promise.resolve(null); },
  registerView(name, fn) { if (name === 'clients') viewFn = fn; },
};

const SOURCE = path.join(__dirname, '..', '..', 'public', 'app', 'views', 'clients.js');
vm.runInNewContext(
  fs.readFileSync(SOURCE, 'utf8'),
  {
    window: {
      Reddably,
      ReddablyDiagnoses: { label(c) { return c; } },
      ReddablyPhone: { normalize(v) { return { ok: true, value: v }; } },
      ReddablyPlan: null,
      location: { hash: '' },
    },
    document: fakeDocument,
    console,
    Promise,
    Date,
  }
);

assert.ok(typeof viewFn === 'function', 'clients.js registers the clients view');

function flush() {
  return new Promise((resolve) => setImmediate(() => setImmediate(() => setImmediate(resolve))));
}

function plain(v) {
  return JSON.parse(JSON.stringify(v === undefined ? null : v));
}

// Render the chart for the given client + policies and hand back the root.
async function chart(clientOver, insurance) {
  currentClient = client(clientOver);
  currentInsurance = insurance === undefined ? [policy()] : insurance;
  const root = createElement('div');
  viewFn(root, [CLIENT_ID]);
  await flush();
  return root;
}

// --- the tests ---------------------------------------------------------------

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- 1. the banner appears exactly when a clinician can meaningfully confirm --

test('a complete intake on an awaiting_info client offers the confirm', async () => {
  const root = await chart();
  const button = confirmButton(root);
  assert.ok(button, 'the "Save as default" button is rendered');
  assert.strictEqual(button.className, 'btn btn--primary',
    'the confirm is the primary action');

  // The banner explains the stake: this client is not billable until confirmed.
  assert.ok(/not billable until you do/i.test(root.textContent),
    'the banner says the client is not billable yet');
  assert.ok(/Patient submitted their information/i.test(root.textContent),
    'the banner names what happened');
});

test('the banner is the FIRST thing on the chart, above the header card', async () => {
  const root = await chart();
  const button = confirmButton(root);
  const banner = walk(root).find((el) => walk(el).indexOf(button) !== -1
    && el.className.indexOf('stack') === 0);
  const view = walk(root).find((el) => el.className === 'view stack');
  const cards = (view.childNodes || []).filter((c) => c.nodeType === 1);
  // backLink is first; the banner comes before the header card.
  assert.ok(cards.indexOf(banner) < cards.findIndex((c) => c.className === 'card'),
    'the review banner precedes the header card');
});

// --- 2. the readiness rule mirrors intakeCompleteness ------------------------

test('no confirm while the patient is still missing a demographic', async () => {
  const missing = [
    { date_of_birth: null },
    { address_line1: '' },
    { city: null },
    { state: '   ' },
    { postal_code: null },
  ];
  for (const over of missing) {
    const root = await chart(over);
    assert.strictEqual(confirmButton(root), null,
      'no confirm with ' + JSON.stringify(over) + ' missing');
  }
});

test('no confirm while the insurance half is incomplete', async () => {
  const cases = [
    { label: 'no policy at all', insurance: [] },
    { label: 'no carrier', insurance: [policy({ carrier_name: '' })] },
    { label: 'no member id', insurance: [policy({ member_id: null })] },
    // The "can't find my insurer" escape hatch: everything else is filled in, but
    // the claim cannot be routed, so this is NOT confirmable.
    { label: 'escape hatch (null payer_id)', insurance: [policy({ payer_id: null })] },
    // A secondary policy is not the one a claim bills.
    { label: 'only a secondary policy', insurance: [policy({ is_primary: false })] },
    { label: 'primary policy soft-deleted', insurance: [policy({ is_hidden: true })] },
  ];
  for (const c of cases) {
    const root = await chart({}, c.insurance);
    assert.strictEqual(confirmButton(root), null, 'no confirm when: ' + c.label);
  }
});

// --- 3. clients the practice already decided about ---------------------------

test('no confirm for an already-active client', async () => {
  const root = await chart({ status: 'active' });
  assert.strictEqual(confirmButton(root), null,
    'confirming is one-time — an active client is not asked again');
});

test('no confirm for a client the practice retired', async () => {
  const root = await chart({ status: 'inactive' });
  assert.strictEqual(confirmButton(root), null,
    'a retired client is never offered a path back to billable here');
});

// --- 4. what the click actually does -----------------------------------------

test('the confirm sends exactly PATCH /clients/{id} { status: active }', async () => {
  const root = await chart();
  calls.length = 0;
  toasts.length = 0;

  const button = confirmButton(root);
  button.dispatch('click');
  assert.strictEqual(button.disabled, true, 'the button disables while saving');
  assert.strictEqual(button.textContent, 'Saving…', 'and says so');
  await flush();

  const updates = calls.filter((c) => c.name === 'clients.update');
  assert.strictEqual(updates.length, 1, 'exactly one write');
  assert.strictEqual(updates[0].args[0], CLIENT_ID, 'scoped to this client');
  assert.deepStrictEqual(plain(updates[0].args[1]), { status: 'active' },
    'status is the ONLY field the confirm writes — it never re-sends the chart');

  // It reloads so the chart reflects the confirmed state (banner gone).
  assert.ok(calls.some((c) => c.name === 'clients.get'), 'the chart reloads after confirming');
  assert.ok(toasts.some((t) => t.tone === 'success'), 'the clinician gets confirmation');
});

test('a failed confirm restores the button instead of stranding it', async () => {
  const root = await chart();
  const button = confirmButton(root);
  const original = api.clients.update;
  api.clients.update = function () {
    return Promise.reject(new Error('Network is down'));
  };
  try {
    button.dispatch('click');
    await flush();
    assert.strictEqual(button.disabled, false, 'the button is usable again');
    assert.strictEqual(button.textContent, 'Save as default', 'and reads normally');
    assert.ok(toasts.some((t) => t.tone === 'error' && /Network is down/.test(t.message)),
      'the failure is surfaced');
  } finally {
    api.clients.update = original;
  }
});

// --- 5. design: stone/ink, never sage, never danger --------------------------

test('the confirm is stone/ink and the banner uses tokens, not raw hex', async () => {
  const root = await chart();
  const button = confirmButton(root);
  assert.ok(button.className.indexOf('btn--danger') === -1, 'confirming is not a danger action');

  const source = fs.readFileSync(SOURCE, 'utf8');
  const banner = source.slice(
    source.indexOf('function intakeReviewBanner'),
    source.indexOf('function headerCard')
  );
  assert.ok(banner.length > 0, 'found the banner source');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(banner), 'no raw hex — design tokens only');
  assert.ok(!/accent|sage/i.test(banner),
    'sage is earned by resolved state; a pending review is neutral stone');
});

// --- runner -----------------------------------------------------------------

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
