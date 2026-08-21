'use strict';

// Unit test — the Edit-client save path, end to end across both halves:
//   public/app/views/clients.js  (buildClientPayload -> PATCH body)
//   backend/handlers/clients.js  (updateClient -> the UPDATE it issues)
//
// The failure mode this pins down: CLEARING a field on the Edit form did not
// save. buildClientPayload ran the collected values through compact(), which
// drops null/''; the key never reached the PATCH; updateClient decides what to
// write with `col in body`, so an absent key means "leave as-is". The request
// succeeded, the toast said "Client updated", and load() brought the old value
// straight back — a silent no-op that reads as data loss to the user, and left
// stale demographics on a chart a claim is built from.
//
// Setting a field to a NEW value always worked; only clearing was dropped. Both
// directions are asserted here so the fix can't regress into the opposite bug
// (a create that ships a wall of nulls, or an edit that stops sending values).
//
// The two halves are checked against each other on purpose: the frontend half
// asserts the exact PATCH body, and the backend half feeds that same body to the
// real handler and asserts the columns land in the UPDATE as SQL NULL. A change
// to either side that breaks the contract fails here.
//
// clients.js is a browser IIFE, so it is evaluated against a minimal fake DOM
// and a fake window.Reddably kit whose api is a recording stub — no jsdom, no
// network, no real DB, matching the hand-stubbed style of the other UI tests
// here. lib/db is stubbed via the require cache. Fixtures are synthetic ids and
// placeholder names — no PHI.
//
//   node backend/tests/clients_edit_save.test.js

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

process.env.JWT_SECRET = 'test-secret-for-unit-only';

// =============================================================================
// A minimal fake DOM
// =============================================================================

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
    dispatch(type, arg) {
      (el.listeners[type] || []).forEach((fn) => fn(arg || { target: el, stopPropagation() {} }));
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

function append(el, children) {
  if (children === null || children === undefined || children === false) return;
  if (Array.isArray(children)) { children.forEach((c) => append(el, c)); return; }
  el.appendChild(children.nodeType ? children : textNode(children));
}

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

function walk(node, out) {
  out = out || [];
  (node.childNodes || []).forEach((c) => { if (c.nodeType === 1) { out.push(c); walk(c, out); } });
  return out;
}

// =============================================================================
// Fixtures — a stored client whose optional fields are all currently SET, so
// clearing each of them is a visible change.
// =============================================================================

const CLIENT_ID = '11111111-2222-3333-4444-555555555555';
const PRACTICE_ID = 'practice-1';

function storedClient(over) {
  return Object.assign({
    id: CLIENT_ID,
    practice_id: PRACTICE_ID,
    primary_clinician_id: null,
    first_name: 'Old',
    last_name: 'Fixture',
    preferred_name: 'Ollie',
    pronouns: 'they/them',
    email: 'fixture@example.com',
    phone: '+13035550100',
    date_of_birth: '1990-01-01',
    gender: 'unknown',
    address_line1: '1 Old St',
    address_line2: 'Apt 4',
    city: 'Denver',
    state: 'CO',
    postal_code: '80202',
    country: 'US',
    diagnosis_codes: ['F411'],
    status: 'active',
    is_hidden: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }, over || {});
}

// Every optional column the Edit form can leave empty. These are exactly the
// fields that used to be dropped; each must survive as an explicit null.
const CLEARABLE = [
  'preferred_name', 'pronouns', 'address_line2',
  'email', 'phone', 'date_of_birth',
];

// What the real collect() in public/app/views.js hands back for a given form
// state. Its contract, verbatim from the source:
//     var val = typeof raw === 'string' ? raw.trim() : raw;
//     ...
//     out[f.name] = val === '' ? null : val;
// i.e. a field the user emptied is collected as null and is PRESENT in the
// object — it is buildClientPayload that decides whether it reaches the wire.
function collected(over) {
  return Object.assign({
    first_name: 'Old',
    last_name: 'Fixture',
    preferred_name: 'Ollie',
    pronouns: 'they/them',
    email: 'fixture@example.com',
    phone: '+13035550100',
    date_of_birth: '1990-01-01',
    gender: 'unknown',
    address_line1: '1 Old St',
    address_line2: 'Apt 4',
    city: 'Denver',
    state: 'CO',
    postal_code: '80202',
    diagnosis_codes: 'F411',
    status: 'active',
  }, over || {});
}

// =============================================================================
// Half 1 — the view: what buildClientPayload puts on the wire
// =============================================================================

const calls = [];
const api = {
  clients: {
    get(id) { calls.push({ name: 'clients.get', args: [id] }); return Promise.resolve({ client: storedClient() }); },
    update(id, payload) { calls.push({ name: 'clients.update', args: [id, payload] }); return Promise.resolve({ client: storedClient() }); },
    create(payload) { calls.push({ name: 'clients.create', args: [payload] }); return Promise.resolve({ client: storedClient() }); },
    list() { calls.push({ name: 'clients.list', args: [] }); return Promise.resolve({ clients: [storedClient()] }); },
  },
  insuranceRecords: { list() { return Promise.resolve({ insurance_records: [] }); } },
  sessions: { list() { return Promise.resolve({ sessions: [] }); } },
  users: { list() { return Promise.resolve({ users: [] }); } },
};

let scriptedFormResult = null;   // what the stubbed formModal resolves with
const toasts = [];

const Reddably = {
  h,
  api,
  clear(el) { while (el.firstChild) el.removeChild(el.firstChild); },
  currentUser() { return { role: 'practice_admin' }; },
  renderLoading(root) { this.clear(root); },
  renderError(root, err) { this.clear(root); root.appendChild(h('div', null, String(err && err.message))); },
  renderEmpty(root, opts) { this.clear(root); root.appendChild(h('div', null, opts.title)); },
  fmtDate(s) { return s ? String(s).slice(0, 10) : '—'; },
  fmtMoney(v) { return v == null ? '—' : '$' + v; },
  statusBadge(s) { return h('span', null, s); },
  toast(message, tone) { toasts.push({ message, tone }); },
  navigate() {},
  confirmModal() { return Promise.resolve(false); },
  formModal() { return Promise.resolve(scriptedFormResult); },
  registerView(name, fn) { if (name === 'clients') Reddably._viewFn = fn; },
};

vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app', 'views', 'clients.js'), 'utf8'),
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

assert.ok(typeof Reddably._viewFn === 'function', 'clients.js registers the clients view');

const flush = () => new Promise((r) => setImmediate(() => setImmediate(() => setImmediate(r))));

// clients.js runs in its own vm context, so the arrays it builds have a
// different Array prototype and deepStrictEqual would reject them on identity
// alone. Round-trip through JSON to compare by value.
function plain(v) {
  return JSON.parse(JSON.stringify(v === undefined ? null : v));
}

function findButton(root, label) {
  return walk(root).filter((el) => el.tagName === 'BUTTON')
    .find((b) => b.textContent === label) || null;
}

// Render the client chart, click "Edit", and return the PATCH body the view sent.
async function editPayload(values) {
  scriptedFormResult = values;
  calls.length = 0;
  toasts.length = 0;
  const root = createElement('div');
  Reddably._viewFn(root, [CLIENT_ID]);
  await flush();
  const btn = findButton(root, 'Edit');
  assert.ok(btn, 'the chart offers an Edit button');
  btn.dispatch('click');
  await flush();
  const upd = calls.find((c) => c.name === 'clients.update');
  assert.ok(upd, 'clicking Edit and submitting issues a clients.update');
  assert.strictEqual(upd.args[0], CLIENT_ID, 'scoped to this client');
  return upd.args[1];
}

// Render the client LIST, click "New client", and return the POST body.
async function createPayload(values) {
  scriptedFormResult = values;
  calls.length = 0;
  toasts.length = 0;
  const root = createElement('div');
  Reddably._viewFn(root, []);
  await flush();
  const btn = findButton(root, 'New client');
  assert.ok(btn, 'the client list offers a "New client" button');
  btn.dispatch('click');
  await flush();
  const created = calls.find((c) => c.name === 'clients.create');
  assert.ok(created, 'submitting the create form issues a clients.create');
  return created.args[0];
}

// =============================================================================
// Half 2 — the handler: what updateClient does with that body
// =============================================================================

let capturedUpdate = null;

const fakeDb = {
  query: async (sql, params) => {
    if (/select practice_id from users where id/i.test(sql)) {
      return { rows: [{ practice_id: PRACTICE_ID }], rowCount: 1 };
    }
    if (/select \* from clients where id/i.test(sql)) {
      return { rows: [storedClient()], rowCount: 1 };
    }
    if (/update clients set/i.test(sql)) {
      capturedUpdate = { text: sql.replace(/\s+/g, ' ').trim(), params };
      // Reflect the SETs back onto the row so the response mirrors the DB.
      const after = storedClient();
      const re = /(\w+) = \$(\d+)/g;
      let m;
      while ((m = re.exec(capturedUpdate.text)) !== null) after[m[1]] = params[Number(m[2]) - 1];
      return { rows: [after], rowCount: 1 };
    }
    if (/insert into audit_log/i.test(sql)) return { rows: [], rowCount: 1 };
    throw new Error('unexpected query: ' + sql);
  },
};

const dbPath = require.resolve(path.join(__dirname, '..', 'lib', 'db.js'));
require.cache[dbPath] = new Module(dbPath, module);
require.cache[dbPath].filename = dbPath;
require.cache[dbPath].loaded = true;
require.cache[dbPath].exports = fakeDb;

const { sign } = require(path.join(__dirname, '..', 'lib', 'jwt.js'));
const clientsHandler = require(path.join(__dirname, '..', 'handlers', 'clients.js'));

function patchEvent(body) {
  const token = sign({ id: 'user-1', practice_id: PRACTICE_ID, role: 'practice_admin' });
  return {
    httpMethod: 'PATCH',
    headers: { authorization: `Bearer ${token}` },
    pathParameters: { id: CLIENT_ID },
    body: JSON.stringify(body),
    requestContext: { http: { method: 'PATCH', sourceIp: '203.0.113.9' } },
  };
}

// Send a PATCH body through the real handler; return { status, client, sql }.
async function patch(body) {
  capturedUpdate = null;
  const res = await clientsHandler.handler(patchEvent(body));
  return {
    status: res.statusCode,
    client: (JSON.parse(res.body) || {}).client,
    body: JSON.parse(res.body),
    sql: capturedUpdate,
  };
}

// The value bound to `col = $n` in the captured UPDATE, or a thrown assertion
// when the column is not in the statement at all.
function boundValue(col) {
  assert.ok(capturedUpdate, 'an UPDATE was issued');
  const m = new RegExp(`\\b${col}\\s*=\\s*\\$(\\d+)`).exec(capturedUpdate.text);
  assert.ok(m, `expected the UPDATE to set ${col}`);
  return capturedUpdate.params[Number(m[1]) - 1];
}

// =============================================================================
// Tests
// =============================================================================

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- 1. the regression: clearing a field must reach the wire as null ---------

test('clearing an optional field sends it as an explicit null, not an omission', async () => {
  const cleared = {};
  CLEARABLE.forEach((k) => { cleared[k] = null; });
  const payload = await editPayload(collected(cleared));

  CLEARABLE.forEach((col) => {
    assert.ok(col in payload,
      `${col} must be PRESENT in the PATCH body — an omitted key means "leave as-is", `
      + 'so dropping it silently discards the user\'s edit');
    assert.strictEqual(payload[col], null, `${col} is sent as an explicit null`);
  });
});

test('each clearable field is dropped-proof on its own, not just as a batch', async () => {
  for (const col of CLEARABLE) {
    const over = {};
    over[col] = null;
    const payload = await editPayload(collected(over));
    assert.ok(col in payload, `clearing ${col} alone still reaches the PATCH body`);
    assert.strictEqual(payload[col], null, `${col} alone is sent as null`);
    // The untouched fields keep their values — clearing one thing clears one thing.
    CLEARABLE.filter((c) => c !== col).forEach((other) => {
      assert.notStrictEqual(payload[other], null,
        `clearing ${col} must not blank ${other}`);
    });
  }
});

test('the handler turns those nulls into SQL NULLs on the real columns', async () => {
  const cleared = {};
  CLEARABLE.forEach((k) => { cleared[k] = null; });
  const payload = await editPayload(collected(cleared));

  const res = await patch(payload);
  assert.strictEqual(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

  CLEARABLE.forEach((col) => {
    assert.strictEqual(boundValue(col), null,
      `${col} must be written as NULL — the whole point of clearing it`);
    assert.strictEqual(res.client[col], null,
      `${col} reads back as null, so the chart shows the cleared value after load()`);
  });
});

// --- 2. the direction that already worked must keep working ------------------

test('changing a field to a new value still saves (the reported repro)', async () => {
  const payload = await editPayload(collected({
    first_name: 'New',
    address_line1: '742 Evergreen Ter',
  }));
  assert.strictEqual(payload.first_name, 'New', 'the new first name is sent');
  assert.strictEqual(payload.address_line1, '742 Evergreen Ter', 'the new address is sent');

  const res = await patch(payload);
  assert.strictEqual(res.status, 200, 'the edit succeeds');
  assert.strictEqual(boundValue('first_name'), 'New', 'first_name is written');
  assert.strictEqual(boundValue('address_line1'), '742 Evergreen Ter', 'address_line1 is written');
  assert.strictEqual(res.client.first_name, 'New', 'and reads back changed');
  assert.strictEqual(res.client.address_line1, '742 Evergreen Ter', 'and reads back changed');
  assert.ok(toasts.some((t) => t.tone === 'success'), 'the user is told it saved');
});

test('an untouched edit re-sends every field unchanged and changes nothing', async () => {
  const payload = await editPayload(collected());
  const res = await patch(payload);
  assert.strictEqual(res.status, 200, 'a no-op edit is still a valid save');
  const before = storedClient();
  Object.keys(payload).forEach((col) => {
    if (col === 'diagnosis_codes') return;   // array; compared below
    assert.strictEqual(res.client[col], before[col],
      `${col} is unchanged by an edit that touched nothing`);
  });
  assert.deepStrictEqual(plain(res.client.diagnosis_codes), ['F411'], 'diagnosis codes unchanged');
});

// --- 3. create keeps compacting — a new client sends no wall of nulls --------

test('create still omits blank optional fields instead of sending nulls', async () => {
  const blank = {};
  CLEARABLE.forEach((k) => { blank[k] = null; });
  const payload = await createPayload(collected(blank));

  CLEARABLE.forEach((col) => {
    assert.ok(!(col in payload),
      `${col} must be OMITTED on create — a brand-new client has nothing to clear`);
  });
  assert.strictEqual(payload.first_name, 'Old', 'the fields that do have values are still sent');
  assert.strictEqual(payload.gender, 'unknown', 'and so are the required ones');
});

test('create omits diagnosis_codes when empty; edit always sends the array', async () => {
  const created = await createPayload(collected({ diagnosis_codes: '' }));
  assert.ok(!('diagnosis_codes' in created),
    'an empty diagnosis picker is omitted on create');

  const edited = await editPayload(collected({ diagnosis_codes: '' }));
  assert.deepStrictEqual(plain(edited.diagnosis_codes), [],
    'on edit an empty array is sent so clearing all codes persists');

  const res = await patch(edited);
  assert.strictEqual(res.status, 200, 'clearing the codes succeeds');
  assert.strictEqual(boundValue('diagnosis_codes'), null,
    'an empty array clears the column to NULL');
});

// --- 4. the handler contract the view now depends on -------------------------

test('a field ABSENT from the body is still left alone (the "leave as-is" rule)', async () => {
  // This is the behavior that made the dropped keys a silent no-op. It is
  // correct on its own and must stay — the view is what had to change.
  const res = await patch({ first_name: 'Only' });
  assert.strictEqual(res.status, 200, 'a partial PATCH is valid');
  assert.strictEqual(boundValue('first_name'), 'Only', 'the named field is written');
  CLEARABLE.forEach((col) => {
    assert.ok(!new RegExp(`\\b${col}\\s*=\\s*\\$`).test(capturedUpdate.text),
      `${col} is not in the UPDATE when the body never mentioned it`);
  });
});

test('clearing a field never weakens the required ones', async () => {
  // first_name/last_name are required: present-but-empty is a 400, not a NULL
  // write. Clearing an optional field must not open a path to a nameless client.
  const res = await patch({ first_name: '', preferred_name: null });
  assert.strictEqual(res.status, 400, 'an empty required name is rejected');
  assert.ok(/first_name cannot be empty/.test(res.body.error), 'and says why');
  assert.strictEqual(capturedUpdate, null, 'no UPDATE is issued at all');
});

// --- 5. guard the source itself ---------------------------------------------

test('compact() is no longer on the edit path', async () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'app', 'views', 'clients.js'), 'utf8');
  const fn = source.slice(
    source.indexOf('function buildClientPayload'),
    source.indexOf('function clientName'));
  assert.ok(fn.length > 0, 'found buildClientPayload');
  assert.ok(/isEdit \? shallow\(values\) : compact\(values\)/.test(fn),
    'edit sends every collected field; only create compacts');
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
  if (failed) {
    console.error(`\nclients_edit_save.test.js: ${failed} failing`);
    process.exit(1);
  }
  console.log('clients_edit_save.test.js: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
