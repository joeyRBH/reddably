'use strict';

// Unit test — the visual weight of the two OUTSTANDING actions on the client
// chart (public/app/views/clients.js + public/app/components.css).
//
// Both actions previously wore `btn btn--ghost btn--sm`, the quietest treatment
// in the system, on steps that decide whether a client can be billed at all:
// getting a card on file, and checking whether a policy's OON coverage is worth
// billing against. "Verify" was additionally the first of three tiny buttons
// sharing a cell with a red Delete. This test pins the corrected ladder:
//
//   ghost      — an action that is merely available (re-verify, send a new link)
//   secondary  — outstanding work that is not the screen's single primary action
//   primary    — the one action the screen is about (get a card on file)
//
// and the design-system rule underneath it: stone/ink carries default action,
// so an action still WAITING to happen never wears sage. Sage is earned by
// resolved state (card on file, active coverage) and appears on the badge, not
// the button.
//
// Also pinned, because it was a real hole rather than a style choice: a client
// with no phone AND no card used to render no billing row at all, so unresolved
// billing setup looked identical to finished billing setup. It now names the
// prerequisite, and deliberately offers NO button — POST /clients/{id}/
// send-payment-link answers 400 without a phone on file, so a button there is a
// dead end by construction.
//
// clients.js is a browser IIFE, so it is evaluated against a minimal fake DOM
// and a fake window.Reddably kit whose api is a recording stub — no jsdom, no
// network, no real DB, matching the hand-stubbed style of the other UI tests
// here. Fixtures are synthetic ids and placeholder names — no PHI.
//
//   node backend/tests/action_button_prominence.test.js

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

// A button by its exact label, wherever it lives — null when absent.
function byLabel(root, label) {
  return buttons(root).find((b) => b.textContent === label) || null;
}

// Every badge's text, so a state can be asserted without depending on layout.
function badgeTexts(root) {
  return walk(root)
    .filter((el) => String(el.className).indexOf('badge') === 0)
    .map((el) => el.textContent);
}

// --- fixtures ----------------------------------------------------------------

const CLIENT_ID = 'c-1';

// An ACTIVE client, so the intake review banner (a separate concern, pinned by
// intake_confirm_ui.test.js) never renders and cannot supply a stray
// .btn--primary that these assertions would mistake for the billing action.
function client(over) {
  return Object.assign({
    id: CLIENT_ID,
    practice_id: 'p-1',
    first_name: 'Test',
    last_name: 'Client',
    status: 'active',
    phone: '+13035550123',
    date_of_birth: '1990-01-01',
    gender: 'female',
    address_line1: '1 Main St',
    city: 'Denver',
    state: 'CO',
    postal_code: '80202',
    diagnosis_codes: [],
    payment_method_last4: null,
    payment_method_brand: null,
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
    benefits_checked_at: null,
    benefits_summary: null,
  }, over || {});
}

// A policy with a stored benefit check — the resolved state.
function verifiedPolicy(over) {
  return policy(Object.assign({
    benefits_checked_at: '2026-08-01T00:00:00.000Z',
    benefits_summary: {
      active: true,
      planName: 'Choice PPO',
      deductible: { individual: 2000, met: 500 },
      outOfPocket: {},
    },
  }, over || {}));
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
    sendPaymentLink(id) {
      calls.push({ name: 'clients.sendPaymentLink', args: [id] });
      return Promise.resolve({ ok: true });
    },
    list() { return Promise.resolve({ clients: [] }); },
  },
  insuranceRecords: {
    list() { return Promise.resolve({ insurance_records: currentInsurance }); },
    update() { return Promise.resolve({}); },
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

const CLIENTS_SOURCE = path.join(__dirname, '..', '..', 'public', 'app', 'views', 'clients.js');
const CLIENTS_SRC = fs.readFileSync(CLIENTS_SOURCE, 'utf8');

vm.runInNewContext(CLIENTS_SRC, {
  window: {
    Reddably,
    ReddablyDiagnoses: { label(c) { return c; } },
    ReddablyPhone: { normalize(v) { return { ok: true, value: v }; } },
    // 'founder' so verifyBenefits takes the check path rather than the upgrade
    // modal — this test is about the button, not the plan gate.
    ReddablyPlan: { state: { loaded: true }, get() { return 'founder'; } },
    location: { hash: '' },
  },
  document: fakeDocument,
  console,
  Promise,
  Date,
});

assert.ok(typeof viewFn === 'function', 'clients.js registers the clients view');

function flush() {
  return new Promise((resolve) => setImmediate(() => setImmediate(() => setImmediate(resolve))));
}

// Render the chart for the given client + policies and hand back the root.
async function chart(clientOver, insurance) {
  currentClient = client(clientOver);
  currentInsurance = insurance === undefined ? [policy()] : insurance;
  calls.length = 0;
  const root = createElement('div');
  viewFn(root, [CLIENT_ID]);
  await flush();
  return root;
}

// --- the tests ---------------------------------------------------------------

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- 1. the payment link, when there is no card on file ----------------------

test('no card + a phone: the payment link is the PRIMARY action, at full size', async () => {
  const root = await chart();
  const button = byLabel(root, 'Send payment link');

  assert.ok(button, 'the payment-link button is rendered');
  assert.strictEqual(button.className, 'btn btn--primary',
    'outstanding billing setup wears ink at full size — not ghost, not --sm');
  assert.ok(badgeTexts(root).indexOf('No card on file') !== -1,
    'the unresolved state is named by a badge, not left to be inferred');
});

test('the payment-link button actually sends the link', async () => {
  const root = await chart();
  byLabel(root, 'Send payment link').dispatch('click');
  await flush();
  const sent = calls.filter((c) => c.name === 'clients.sendPaymentLink');
  assert.strictEqual(sent.length, 1, 'exactly one send-payment-link call');
  assert.strictEqual(sent[0].args[0], CLIENT_ID, 'for this client');
});

test('no card + NO phone: the row still renders and names the prerequisite', async () => {
  // The regression this guards: the row used to return null here, so a client
  // with billing entirely unset looked exactly like one already set up.
  const root = await chart({ phone: null });

  assert.ok(badgeTexts(root).indexOf('No card on file') !== -1,
    'the unresolved state is still shown when there is no phone');
  assert.ok(/Add a phone number to send a payment link/i.test(root.textContent),
    'the row names the missing prerequisite');
  assert.strictEqual(byLabel(root, 'Send payment link'), null,
    'no button: send-payment-link 400s without a phone, so offering it is a dead end');
});

test('card on file: the action steps DOWN to ghost and sage carries the state', async () => {
  const root = await chart({
    payment_method_last4: '4242',
    payment_method_brand: 'visa',
    payment_method_exp_month: 4,
    payment_method_exp_year: 2030,
  });

  assert.strictEqual(byLabel(root, 'Send payment link'), null,
    'the outstanding-action label is gone once a card exists');
  const again = byLabel(root, 'Send new link');
  assert.ok(again, 'a quiet re-send is still offered');
  assert.ok(/btn--ghost/.test(again.className) && /btn--sm/.test(again.className),
    'a resolved state gets a ghost action, never ink');

  const badges = badgeTexts(root).join(' | ');
  assert.ok(/Card on file/.test(badges), 'the sage success badge carries the resolved state');
});

// --- 2. verifying benefits ---------------------------------------------------

test('an unverified policy gets its own row with a SECONDARY verify button', async () => {
  const root = await chart(undefined, [policy()]);
  const button = byLabel(root, 'Verify benefits');

  assert.ok(button, 'the verify action is rendered');
  assert.strictEqual(button.className, 'btn btn--secondary btn--sm',
    'outstanding work wears the ink outline, not the quietest ghost');
  assert.ok(badgeTexts(root).indexOf('Benefits not verified') !== -1,
    'the unverified state is named');
});

test('verify no longer shares the cramped cell with Edit and a red Delete', async () => {
  const root = await chart(undefined, [policy()]);

  // The old bare 'Verify' label is gone entirely.
  assert.strictEqual(byLabel(root, 'Verify'), null,
    "the old bare 'Verify' button is retired");

  // And the verify action is NOT a sibling of Delete any more.
  const verify = byLabel(root, 'Verify benefits');
  const del = byLabel(root, 'Delete');
  assert.ok(del, 'Delete is still offered');
  assert.notStrictEqual(verify.parentNode, del.parentNode,
    'verifying benefits no longer sits in the same cell as a destructive action');
});

test('a verified policy shows no prompt, and re-verifying is a QUIET action', async () => {
  const root = await chart(undefined, [verifiedPolicy()]);

  assert.strictEqual(byLabel(root, 'Verify benefits'), null,
    'the prompt row is absent once a check is stored');
  assert.ok(badgeTexts(root).indexOf('Benefits not verified') === -1,
    'and so is the unverified badge');

  const reverify = byLabel(root, 'Re-verify');
  assert.ok(reverify, 're-verifying is still reachable');
  assert.strictEqual(reverify.className, 'btn btn--ghost btn--sm',
    'an already-resolved record gets a ghost action — ink is for outstanding work');
  assert.ok(byLabel(root, 'View result'), 'the stored result is still reachable');
});

test('the prompt and the summary are mutually exclusive, never both', async () => {
  const unverified = await chart(undefined, [policy()]);
  assert.ok(byLabel(unverified, 'Verify benefits') && !byLabel(unverified, 'View result'),
    'unverified: prompt only');

  const verified = await chart(undefined, [verifiedPolicy()]);
  assert.ok(byLabel(verified, 'View result') && !byLabel(verified, 'Verify benefits'),
    'verified: summary only');
});

// --- 3. the design rules the ladder rests on ---------------------------------

test('.btn--secondary is ink-based, token-only, and sits between ghost and primary', async () => {
  const cssPath = path.join(__dirname, '..', '..', 'public', 'app', 'components.css');
  const css = fs.readFileSync(cssPath, 'utf8');

  const block = (css.match(/\.btn--secondary\s*\{[^}]*\}/) || [])[0];
  assert.ok(block, '.btn--secondary is defined');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(block), 'no raw hex — design tokens only');
  assert.ok(/var\(--color-primary\)/.test(block),
    'it is ink-led: stone/ink carries default action');
  assert.ok(!/accent/.test(block),
    'never sage — sage is earned by resolved state, not pending work');
  assert.ok(/background:\s*transparent/.test(block),
    'unfilled, so it stays subordinate to the filled --primary');
});

test('the new chart markup uses tokens, and pending work never wears sage or danger', async () => {
  // The two blocks this PR authored, isolated from the rest of the file.
  const billing = (CLIENTS_SRC.match(/function billingRow\(client\)[\s\S]*?\n    }\n/) || [])[0];
  const prompt = (CLIENTS_SRC.match(/function vobPromptRow\(record\)[\s\S]*?\n      }\n/) || [])[0];

  assert.ok(billing, 'found billingRow source');
  assert.ok(prompt, 'found vobPromptRow source');

  [['billingRow', billing], ['vobPromptRow', prompt]].forEach(([name, src]) => {
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(src), name + ': no raw hex — design tokens only');
    assert.ok(!/badge--danger/.test(src),
      name + ': unfinished setup is neutral workflow state, not a failure');
  });

  // vobPromptRow describes work that has NOT happened, so nothing in it is sage.
  assert.ok(!/badge--success|accent/.test(prompt),
    'vobPromptRow: sage is earned by resolution — an unrun check has earned nothing');
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
