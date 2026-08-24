'use strict';

// Unit test — Claims workspace rendering (public/app/views/claims.js).
//
// The split this pins down: drafts are verification work and live on top under
// "Ready to verify and submit"; everything else is history underneath. Covers:
//
//   * draft vs non-draft partitioning, in both sections, always;
//   * drafts sorted by date of service descending, created_at as the stable
//     tie-breaker; history sorted by submitted_at descending with created_at as
//     the deterministic fallback for rows that were never submitted;
//   * a draft row shows client, date of service, CPT, diagnosis, billed amount,
//     payer and the server's readiness verdict;
//   * the readiness badge is INFORMATIONAL — the list offers no submit, no
//     batch action, and ready_to_review is never treated as approval;
//   * the status filter belongs to the submitted section only and can never
//     empty the draft queue;
//   * each section has its own empty state;
//   * "New claim" still opens the existing two-step picker, rendered as a
//     secondary (ghost) action.
//
// claims.js is a browser IIFE, so it is evaluated against a minimal fake DOM and
// a fake window.Reddably kit whose api is a recording stub — no jsdom, no
// network, no real DB, in keeping with the hand-stubbed style of the other tests
// here. Fixtures are synthetic ids and placeholder names — no PHI.
//
//   node backend/tests/claims_workspace_ui.test.js

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

function tagged(node, tag) {
  return walk(node).filter((el) => el.tagName === tag);
}

function buttonLabels(node) {
  return tagged(node, 'BUTTON').map((b) => b.textContent);
}

// Body rows of the section's table (skips the header row, which lives in THEAD).
function bodyRows(node) {
  const tbody = tagged(node, 'TBODY')[0];
  return tbody ? tagged(tbody, 'TR') : [];
}

function cellTexts(row) {
  return tagged(row, 'TD').map((td) => td.textContent);
}

function headers(node) {
  return tagged(node, 'TH').map((th) => th.textContent);
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

function sectionOrNull(root, title) {
  return walk(root).find(
    (el) => el.className === 'card' &&
      walk(el).some((c) => c.className === 'card__title' && c.textContent === title)
  ) || null;
}

// --- fixtures ----------------------------------------------------------------

function readiness(state, blockers, warnings) {
  return { state, blockers: blockers || [], warnings: warnings || [] };
}

function claim(over) {
  return Object.assign({
    id: 'x', client_id: 'c1', client_name: 'Client X', session_date: '2026-06-01',
    cpt_code: '90837', diagnosis_codes: ['F411'], place_of_service: '10',
    billed_amount: '150.00', payer_name: 'Aetna', payer_id: '60054',
    status: 'draft', submitted_at: null, created_at: '2026-06-01T09:00:00.000Z',
    readiness: readiness('ready_to_review'),
  }, over || {});
}

// Three drafts whose service dates deliberately disagree with creation order,
// plus two same-day drafts to exercise the created_at tie-breaker.
const DRAFTS = [
  claim({ id: 'd-old', session_date: '2026-05-01', created_at: '2026-05-01T09:00:00.000Z',
    readiness: readiness('needs_correction',
      [{ code: 'client_date_of_birth', message: 'Client date of birth is required.', status: 422 }]) }),
  claim({ id: 'd-new', session_date: '2026-07-10', created_at: '2026-05-02T09:00:00.000Z',
    client_name: 'Client Newest', diagnosis_codes: ['F411', 'F331', 'F401', 'F900'],
    readiness: readiness('review_warning', [],
      [{ code: 'member_id_length_unusual', message: 'Member ID length looks unusual.' }]) }),
  claim({ id: 'd-mid-a', client_name: 'Client Earlier', session_date: '2026-06-15',
    created_at: '2026-06-15T08:00:00.000Z' }),
  claim({ id: 'd-mid-b', client_name: 'Client Later', session_date: '2026-06-15',
    created_at: '2026-06-15T11:00:00.000Z' }),
];

// History, including a void claim that was never submitted (submitted_at null)
// and an unconfirmed-submission sentinel (submitted, no control number).
const HISTORY = [
  claim({ id: 'h-paid', status: 'paid', submitted_at: '2026-06-20T00:00:00.000Z',
    created_at: '2026-06-19T00:00:00.000Z', readiness: null }),
  claim({ id: 'h-sentinel', status: 'submitted', control_number: null,
    submitted_at: '2026-07-01T00:00:00.000Z', created_at: '2026-06-30T00:00:00.000Z', readiness: null }),
  claim({ id: 'h-void', status: 'void', submitted_at: null,
    created_at: '2026-06-25T00:00:00.000Z', readiness: null }),
  claim({ id: 'h-denied', status: 'denied', submitted_at: '2026-06-10T00:00:00.000Z',
    created_at: '2026-06-09T00:00:00.000Z', readiness: null }),
];

// --- recording api stub ------------------------------------------------------

const calls = [];
let listResult = DRAFTS.concat(HISTORY);

const api = {
  claims: {
    list(filters) {
      calls.push({ name: 'claims.list', args: [filters] });
      const status = filters && filters.status;
      const rows = status ? listResult.filter((c) => c.status === status) : listResult;
      return Promise.resolve({ claims: rows });
    },
  },
  clients: {
    list() {
      calls.push({ name: 'clients.list', args: [] });
      return Promise.resolve({ clients: [{ id: 'c1', first_name: 'Client', last_name: 'X' }] });
    },
  },
  sessions: {
    list(filters) {
      calls.push({ name: 'sessions.list', args: [filters] });
      return Promise.resolve({ sessions: [{ id: 's1', session_date: '2026-06-01', cpt_code: '90837', fee: 150 }] });
    },
  },
};

// --- fake window.Reddably kit ------------------------------------------------

const modals = [];
let emptyState = null;

function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

let viewFn = null;
const Reddably = {
  h,
  api,
  clear,
  renderLoading(root) { clear(root); root.appendChild(h('div', { class: 'skeleton' })); },
  renderError(root, err) { clear(root); root.appendChild(h('div', { class: 'inline-error' }, String(err && err.message))); },
  renderEmpty(root, opts) {
    clear(root);
    emptyState = opts;
    root.appendChild(h('div', { class: 'empty-state' }, opts.title));
  },
  fmtDate(s) { return s ? String(s).slice(0, 10) : '—'; },
  fmtMoney(v) { return v == null ? '—' : '$' + v; },
  statusBadge(status) { return h('span', { class: 'badge badge--neutral' }, status); },
  scrubVendor(s) { return s; },
  toast() {},
  navigate(hash) { calls.push({ name: 'navigate', args: [hash] }); },
  confirmModal() { return Promise.resolve(false); },
  formModal(opts) { modals.push(opts); return Promise.resolve(null); },
  registerView(name, fn) { if (name === 'claims') viewFn = fn; },
};

vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app', 'views', 'claims.js'), 'utf8'),
  { window: { Reddably }, document: fakeDocument, console, Promise, Date }
);

assert.ok(typeof viewFn === 'function', 'claims.js registers the claims view');

function flush() {
  return new Promise((resolve) => setImmediate(() => setImmediate(() => setImmediate(resolve))));
}

// Objects built inside the vm carry that context's Object.prototype, so
// deepStrictEqual would reject them on identity alone. Compare plain shapes.
function plain(v) {
  return JSON.parse(JSON.stringify(v === undefined ? null : v));
}

// --- the tests ---------------------------------------------------------------

(async function run() {
  const root = createElement('div');
  viewFn(root, []);
  await flush();

  const drafts = section(root, 'Ready to verify and submit');
  const submitted = section(root, 'Submitted claims');

  // 1. The unfiltered page is ONE request; both sections come from it.
  assert.deepStrictEqual(
    calls.filter((c) => c.name === 'claims.list').map((c) => plain(c.args[0])),
    [null],
    'the default page loads claims once, unfiltered'
  );

  // 2. Verification work is on top, history below.
  const order = walk(root).filter((el) => el.className === 'card');
  assert.strictEqual(order[0], drafts, 'the draft queue is the first card on the page');
  assert.strictEqual(order[1], submitted, 'submitted history comes second');

  // 3. Partitioning: every draft above, every non-draft below, nothing shared.
  const draftIds = bodyRows(drafts).map((r) => cellTexts(r)[0]);
  assert.strictEqual(bodyRows(drafts).length, DRAFTS.length, 'every draft is in the draft section');
  assert.strictEqual(bodyRows(submitted).length, HISTORY.length, 'every non-draft is in history');
  ['h-paid', 'h-void', 'h-denied', 'h-sentinel'].forEach((id) => {
    assert.ok(!drafts.textContent.includes(id), id + ' never appears in the draft queue');
  });

  // 4. Draft rows carry the full verification set, in order.
  assert.deepStrictEqual(headers(drafts), [
    'Client', 'Date of service', 'CPT', 'Diagnosis', 'Billed', 'Payer', 'Validation',
  ], 'a draft row shows everything a human verifies');

  const newest = bodyRows(drafts)[0];
  assert.strictEqual(cellTexts(newest)[0], 'Client Newest');
  assert.strictEqual(cellTexts(newest)[1], '2026-07-10');
  assert.strictEqual(cellTexts(newest)[2], '90837');
  assert.strictEqual(cellTexts(newest)[3], 'F411, F331, F401 +1',
    'multiple diagnoses read concisely, in their stored order');
  assert.strictEqual(cellTexts(newest)[4], '$150.00');
  assert.strictEqual(cellTexts(newest)[5], 'Aetna');
  assert.ok(cellTexts(newest)[6].indexOf('Review warning') === 0, 'the readiness verdict is shown');

  // 5. Drafts sort by service date descending, created_at as the tie-breaker.
  assert.deepStrictEqual(
    bodyRows(drafts).map((r) => cellTexts(r)[1]),
    ['2026-07-10', '2026-06-15', '2026-06-15', '2026-05-01'],
    'drafts are newest date of service first'
  );
  // The two 2026-06-15 drafts share a service date, so created_at breaks the
  // tie deterministically — later creation first.
  assert.deepStrictEqual(
    bodyRows(drafts).slice(1, 3).map((r) => cellTexts(r)[0]),
    ['Client Later', 'Client Earlier'],
    'same-day drafts fall back to creation time descending, stably'
  );
  const draftText = drafts.textContent;

  // 6. Each readiness state renders its own explicit label.
  ['Needs correction', 'Review warning', 'Ready to review'].forEach((label) => {
    assert.ok(draftText.includes(label), 'the "' + label + '" verdict is rendered');
  });
  assert.ok(!draftText.includes('Ready to submit'),
    'the verdict is never phrased as ready to submit');

  // 7. The badge is informational — the list acts on nothing.
  const draftButtons = buttonLabels(drafts);
  assert.deepStrictEqual(draftButtons, [],
    'a draft row offers no submit, approve, or batch action — submission stays on the detail screen');
  assert.ok(!/submit|approve|send/i.test(draftText.replace('Ready to verify and submit', '')),
    'nothing in the queue reads as an action on the claim');
  // Rows open the existing detail screen.
  bodyRows(drafts)[0].dispatch('click');
  assert.deepStrictEqual(calls[calls.length - 1], { name: 'navigate', args: ['claims/d-new'] },
    'a draft row opens the claim detail, where edit and submit live');

  // 8. History sorts by submitted_at desc, created_at as the fallback for a
  //    claim that was never submitted.
  assert.deepStrictEqual(
    bodyRows(submitted).map((r) => tagged(r, 'TD')[3].textContent),
    ['submitted', 'paid', 'denied', 'void'],
    'history is most-recently-submitted first; the never-submitted void row falls back to created_at'
  );
  assert.deepStrictEqual(headers(submitted), [
    'Client', 'Date of service', 'Billed', 'Status', 'Payer', 'Submitted',
  ]);

  // 9. The status filter lives in the submitted section and excludes draft.
  const selects = tagged(root, 'SELECT');
  assert.strictEqual(selects.length, 1, 'exactly one status filter on the page');
  assert.ok(walk(submitted).indexOf(selects[0]) !== -1, 'the filter belongs to the submitted section');
  const options = tagged(selects[0], 'OPTION').map((o) => o.attributes.value);
  assert.deepStrictEqual(options,
    ['', 'submitted', 'processing', 'info_requested', 'denied', 'appealed', 'paid', 'void'],
    'the history filter never offers draft — filtering history cannot hide the queue');

  // 10. Choosing a history status keeps the draft queue intact.
  calls.length = 0;
  selects[0].value = 'paid';
  selects[0].dispatch('change', { target: selects[0] });
  await flush();
  assert.deepStrictEqual(
    calls.filter((c) => c.name === 'claims.list').map((c) => plain(c.args[0])),
    [{ status: 'draft' }, { status: 'paid' }],
    'filtering history re-queries drafts unfiltered alongside the filtered history'
  );
  const draftsAfter = section(root, 'Ready to verify and submit');
  assert.strictEqual(bodyRows(draftsAfter).length, DRAFTS.length,
    'every draft is still visible while history is filtered');
  assert.deepStrictEqual(
    bodyRows(section(root, 'Submitted claims')).map((r) => tagged(r, 'TD')[3].textContent),
    ['paid'], 'history shows only the filtered status');

  // 11. Per-section empty states — one quiet section never blanks the other.
  listResult = HISTORY;
  calls.length = 0;
  viewFn(root, []);
  await flush();
  assert.ok(section(root, 'Ready to verify and submit').textContent
    .includes('No claims waiting for verification.'), 'the draft section has its own empty state');
  assert.ok(sectionOrNull(root, 'Submitted claims'), 'the submitted section still renders its rows');

  listResult = DRAFTS;
  viewFn(root, []);
  await flush();
  assert.ok(section(root, 'Submitted claims').textContent.includes('No submitted claims yet.'),
    'the submitted section has its own empty state');
  assert.strictEqual(bodyRows(section(root, 'Ready to verify and submit')).length, DRAFTS.length,
    'the draft queue is untouched by an empty history');

  // 12. Only a wholly empty, unfiltered workspace falls back to the page-level
  //     placeholder.
  listResult = [];
  emptyState = null;
  viewFn(root, []);
  await flush();
  assert.ok(emptyState && emptyState.title === 'No claims yet',
    'a completely empty workspace still shows the full placeholder');

  // 13. New claim stays functional, and stays secondary.
  listResult = DRAFTS.concat(HISTORY);
  viewFn(root, []);
  await flush();
  const newClaim = tagged(root, 'BUTTON').find((b) => b.textContent === 'New claim');
  assert.ok(newClaim, '"New claim" is still available');
  assert.strictEqual(newClaim.className, 'btn btn--ghost',
    'manual creation is a secondary action, not the page\'s primary call');
  assert.ok(!tagged(root, 'BUTTON').some((b) => /btn--primary/.test(b.className)),
    'nothing in the workspace competes with the verification queue as a primary action');

  calls.length = 0;
  modals.length = 0;
  newClaim.dispatch('click');
  await flush();
  assert.ok(calls.some((c) => c.name === 'clients.list'), 'New claim still loads clients');
  assert.ok(modals.length && /choose client/i.test(modals[0].title),
    'New claim still opens the existing two-step picker');

  // 14. Re-rendering the same root duplicates neither rows nor handlers.
  const beforeRows = tagged(root, 'TR').length;
  viewFn(root, []);
  await flush();
  assert.strictEqual(tagged(root, 'TR').length, beforeRows, 're-rendering does not duplicate rows');
  tagged(root, 'TR').forEach((r) => {
    assert.ok((r.listeners.click || []).length <= 1, 'each row carries a single click handler');
  });

  // 15. The cache-buster for this view was bumped.
  const appHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app', 'app.html'), 'utf8');
  assert.match(appHtml, /\.\/views\/claims\.js\?v=20260824a/,
    'app.html serves claims.js?v=20260824a');

  console.log('PASS claims_workspace_ui.test.js');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
