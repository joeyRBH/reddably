'use strict';

// End-to-end verification of the critical path — the chain that turns a phone
// number into a transmitted claim, walked through the REAL Lambda handlers:
//
//   POST /clients                          staff create the patient (name + phone)
//     -> POST /card-setup/save-details     patient's own demographics land on the chart
//     -> POST /card-setup/save-insurance   patient's own coverage lands on the chart
//        ...and the client is STILL 'awaiting_info' — intake never makes anyone billable
//     -> PATCH /clients/{id} status=active clinician confirms ("Save as default")
//     -> POST /sessions                    a session with CPT / diagnosis / fee
//     -> POST /claims                      draft claim from that session
//     -> GET  /claims                      readiness projection says ready_to_review
//     -> POST /claims/{id}/submit          reaches the clearinghouse adapter
//
// Each unit test in this directory pins one link of that chain. This is the only
// test that walks the WHOLE chain against handlers that actually mutate shared
// state, so it is the one that catches a regression where a link's output stops
// being the next link's input — a column renamed on one side of a handoff, an
// insurance record the claim no longer auto-picks, a confirm step that stops
// writing the status the submit gate reads.
//
// The DB is a single in-memory store shared by all four handlers, routed by SQL
// shape (same require-cache mocking as claim_submit_integrity.test.js). Nothing
// here touches a database or the network. Audit, auth, the payment-link token and
// the clearinghouse adapter are mocked; lib/claims.js is NOT — the real
// insertDraftClaim / ensurePatientControlNumber / primaryInsuranceForClient run,
// because the handoffs between them are exactly what this test exists to check.
// An unrecognized query is a hard error, so a handler that starts reading
// something new fails here rather than silently getting an empty result.
//
// Fixtures are synthetic ids and placeholder names — no PHI.
//
// ON THE NEGATIVE HALF (part B): what stops a claim before it is transmitted,
// pinned as what the code really does rather than what would be nice:
//
//   * client date of birth, practice billing address, and an invalid place of
//     service ARE hard blockers — 422, claim stays draft, adapter never called;
//   * a claim with no insurance record attached is a 400 (it predates the 422
//     blockers), claim stays draft, adapter never called;
//   * the billable CONTENT — billed amount, CPT code, diagnosis, and the payer id
//     that routes the claim — is likewise hard-blocked with a 422 while the claim
//     is still a draft. Two of those matter more than the rest: a missing payer id
//     and an over-limit diagnosis list make the adapter throw while BUILDING the
//     837P, which happens after submit has already moved the claim to 'submitted',
//     so before they were blocked a never-transmitted claim stranded in a
//     retry-blocked 502. The adapter's own refusals remain as a backstop for
//     direct callers, asserted here against the real builder.
//
// The content blockers check those facts are PRESENT, never that they are RIGHT —
// a human still verifies that, which is why the clear state is ready_to_REVIEW.
//
//   node backend/tests/onboarding_to_claim_e2e.test.js

const assert = require('node:assert');
const path = require('node:path');

function mock(rel, exports) {
  const resolved = require.resolve(path.join(__dirname, '..', rel));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// --- fixed ids ---------------------------------------------------------------

const PRACTICE_ID = '11111111-1111-4111-8111-111111111111';
const CLINICIAN_ID = '22222222-2222-4222-8222-222222222222';
const LINK_TOKEN = 'signed-payment-link-token';

let idSeq = 0;
function uuid() {
  idSeq += 1;
  return `00000000-0000-4000-8000-${String(idSeq).padStart(12, '0')}`;
}

// --- in-memory database ------------------------------------------------------

let store;

function resetStore(overrides) {
  const o = overrides || {};
  store = {
    practices: [
      {
        id: PRACTICE_ID,
        name: 'Stone Ridge Counseling',
        npi: '1234567890',
        tax_id: '123456789',
        notification_email: null,
        // The practice billing address the 837P Billing loop requires. Blanked by
        // the missing-billing-address case below.
        address_line1: o.practiceAddress === null ? null : '1 Main St',
        city: o.practiceAddress === null ? null : 'Denver',
        state: o.practiceAddress === null ? null : 'CO',
        postal_code: o.practiceAddress === null ? null : '80202',
        country: 'US',
      },
    ],
    users: [
      {
        id: CLINICIAN_ID,
        practice_id: PRACTICE_ID,
        role: 'practice_admin',
        first_name: 'Dana',
        last_name: 'Cruz',
        npi: '1987654320',
        is_active: true,
      },
    ],
    clients: [],
    insurance_records: [],
    sessions: [],
    claims: [],
    claim_events: [],
    claim_acknowledgments: [],
  };
}

const none = () => ({ rows: [], rowCount: 0 });
const rows = (list) => ({ rows: list.map((r) => ({ ...r })), rowCount: list.length });
const one = (row) => (row ? rows([row]) : none());

// Mirror pg's nullif($n, ''): a blank incoming value is stored as NULL.
const nullifBlank = (v) => (v == null || String(v).trim() === '' ? null : v);

// Mirror coalesce(nullif($n, ''), col): a blank incoming value keeps what is on file.
const keepIfBlank = (incoming, current) => (nullifBlank(incoming) == null ? current : incoming);

function insertRow(table, row) {
  const full = { id: uuid(), created_at: `t${idSeq}`, updated_at: `t${idSeq}`, ...row };
  store[table].push(full);
  return full;
}

// Parse the dynamic SET list of a handler-built UPDATE ("col = $1, col2 = $3")
// into { col: value }, resolving each placeholder against the bound params.
function parseSets(setList, params) {
  const out = {};
  for (const part of setList.split(',')) {
    const m = part.trim().match(/^([a-z_]+)\s*=\s*\$(\d+)$/);
    if (!m) throw new Error(`db mock: cannot parse SET fragment "${part.trim()}"`);
    out[m[1]] = params[Number(m[2]) - 1];
  }
  return out;
}

function routeSelect(q, sql, params) {
  // --- practice scoping + membership checks ---
  if (/^select practice_id from users where id = \$1 and is_active = true/.test(q)) {
    const u = store.users.find((r) => r.id === params[0] && r.is_active);
    return one(u ? { practice_id: u.practice_id } : null);
  }
  if (/^select 1 from users where id = \$1 and practice_id = \$2 and is_active = true/.test(q)) {
    const u = store.users.find((r) => r.id === params[0] && r.practice_id === params[1] && r.is_active);
    return one(u ? { '?column?': 1 } : null);
  }
  if (/^select 1 from clients where id = \$1 and practice_id = \$2 and is_hidden = false/.test(q)) {
    const c = store.clients.find((r) => r.id === params[0] && r.practice_id === params[1] && !r.is_hidden);
    return one(c ? { '?column?': 1 } : null);
  }

  // --- clients ---
  if (/^select \* from clients where id = \$1 and is_hidden = false/.test(q)) {
    return one(store.clients.find((r) => r.id === params[0] && !r.is_hidden));
  }
  if (/^select \* from clients where id = \$1 and practice_id = \$2 and is_hidden = false/.test(q)) {
    return one(store.clients.find((r) => r.id === params[0] && r.practice_id === params[1] && !r.is_hidden));
  }
  if (/^select \* from clients where id = \$1 and practice_id = \$2 limit 1/.test(q)) {
    return one(store.clients.find((r) => r.id === params[0] && r.practice_id === params[1]));
  }

  // --- practices ---
  if (/notification_email/.test(q)) {
    const p = store.practices.find((r) => r.id === params[0]);
    return one(p ? { recipient: nullifBlank(p.notification_email) } : null);
  }
  if (/^select \* from practices where id = \$1 limit 1/.test(q)) {
    return one(store.practices.find((r) => r.id === params[0]));
  }

  // --- insurance records ---
  if (/^select id from insurance_records where client_id = \$1 and is_primary = true/.test(q)) {
    const r = store.insurance_records.find((x) => x.client_id === params[0] && x.is_primary && !x.is_hidden);
    return one(r ? { id: r.id } : null);
  }
  if (/^select \* from insurance_records where practice_id = \$1 and client_id = \$2/.test(q)) {
    const list = store.insurance_records
      .filter((x) => x.practice_id === params[0] && x.client_id === params[1] && !x.is_hidden)
      .sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
    return one(list[0]);
  }
  if (/^select \* from insurance_records where id = \$1 and practice_id = \$2 and is_hidden = false/.test(q)) {
    return one(store.insurance_records.find((x) => x.id === params[0] && x.practice_id === params[1] && !x.is_hidden));
  }

  // --- sessions ---
  if (/^select \* from sessions where id = \$1 and practice_id = \$2 and is_hidden = false/.test(q)) {
    return one(store.sessions.find((r) => r.id === params[0] && r.practice_id === params[1] && !r.is_hidden));
  }
  if (/^select \* from sessions where id = \$1 and practice_id = \$2 limit 1/.test(q)) {
    return one(store.sessions.find((r) => r.id === params[0] && r.practice_id === params[1]));
  }

  // --- users (claim context) ---
  if (/^select \* from users where id = \$1 and practice_id = \$2 limit 1/.test(q)) {
    return one(store.users.find((r) => r.id === params[0] && r.practice_id === params[1]));
  }

  // --- provider billing profiles: none configured in this fixture ---
  if (/from provider_billing_profiles/.test(q)) return none();

  // --- claims ---
  if (/^select 1 from claims where session_id = \$1 and practice_id = \$2/.test(q)) {
    const c = store.claims.find((r) => r.session_id === params[0] && r.practice_id === params[1] && !r.is_hidden);
    return one(c ? { '?column?': 1 } : null);
  }
  if (/^select \* from claims where id = \$1 and practice_id = \$2 and is_hidden = false/.test(q)) {
    return one(store.claims.find((r) => r.id === params[0] && r.practice_id === params[1] && !r.is_hidden));
  }

  // --- GET /claims: the joined list + readiness projection ---
  if (/^select c\.\*,/.test(q) && /from claims c/.test(q)) {
    const list = store.claims.filter((c) => c.practice_id === params[0] && !c.is_hidden);
    return rows(list.map((c) => {
      const cl = store.clients.find((x) => x.id === c.client_id) || {};
      const s = store.sessions.find((x) => x.id === c.session_id) || {};
      const pr = store.practices.find((x) => x.id === c.practice_id) || {};
      const ir = store.insurance_records.find((x) => x.id === c.insurance_record_id) || null;
      return {
        ...c,
        client_first_name: cl.first_name,
        client_last_name: cl.last_name,
        client_preferred_name: cl.preferred_name,
        client_date_of_birth: cl.date_of_birth,
        session_date: s.session_date,
        session_cpt_code: s.cpt_code,
        session_diagnosis_codes: s.diagnosis_codes,
        session_place_of_service: s.place_of_service,
        payer_name: ir ? ir.carrier_name : null,
        payer_id: ir ? ir.payer_id : null,
        ins_is_hidden: ir ? ir.is_hidden : null,
        ins_member_id: ir ? ir.member_id : null,
        ins_subscriber_relationship: ir ? ir.subscriber_relationship : null,
        ins_subscriber_name: ir ? ir.subscriber_name : null,
        ins_subscriber_dob: ir ? ir.subscriber_dob : null,
        practice_address_line1: pr.address_line1,
        practice_city: pr.city,
        practice_state: pr.state,
        practice_postal_code: pr.postal_code,
      };
    }));
  }

  throw new Error(`db mock: unexpected SELECT: ${sql}`);
}

function routeInsert(q, sql, params) {
  if (/^insert into clients/.test(q)) {
    return one(insertRow('clients', {
      practice_id: params[0],
      first_name: params[1],
      last_name: params[2],
      preferred_name: params[3],
      pronouns: params[4],
      email: params[5],
      phone: params[6],
      date_of_birth: params[7],
      gender: params[8],
      address_line1: params[9],
      address_line2: params[10],
      city: params[11],
      state: params[12],
      postal_code: params[13],
      diagnosis_codes: params[14],
      primary_clinician_id: params[15],
      status: params[16] || 'awaiting_info',   // coalesce($17, 'awaiting_info')
      is_hidden: false,
    }));
  }

  if (/^insert into insurance_records/.test(q)) {
    return one(insertRow('insurance_records', {
      practice_id: params[0],
      client_id: params[1],
      carrier_name: params[2],
      member_id: params[3],
      group_number: nullifBlank(params[4]),
      subscriber_relationship: nullifBlank(params[5]),
      subscriber_name: nullifBlank(params[6]),
      subscriber_dob: nullifBlank(params[7]),
      subscriber_gender: nullifBlank(params[8]),
      subscriber_address_line1: nullifBlank(params[9]),
      subscriber_address_line2: nullifBlank(params[10]),
      subscriber_city: nullifBlank(params[11]),
      subscriber_state: nullifBlank(params[12]),
      subscriber_postal_code: nullifBlank(params[13]),
      payer_id: params[14],
      is_primary: true,
      is_hidden: false,
    }));
  }

  if (/^insert into sessions/.test(q)) {
    return one(insertRow('sessions', {
      practice_id: params[0],
      client_id: params[1],
      clinician_id: params[2],
      session_date: params[3],
      duration_minutes: params[4],
      cpt_code: params[5],
      diagnosis_codes: params[6],
      place_of_service: params[7],
      procedure_modifiers: params[8],
      fee: params[9],
      notes: params[10],
      status: params[11] || 'scheduled',        // coalesce($12, 'scheduled')
      is_hidden: false,
    }));
  }

  if (/^insert into claims/.test(q)) {
    return one(insertRow('claims', {
      practice_id: params[0],
      session_id: params[1],
      client_id: params[2],
      clinician_id: params[3],
      insurance_record_id: params[4],
      claim_number: params[5],
      status: 'draft',
      billed_amount: params[6],
      control_number: null,
      patient_control_number: null,
      submission_frequency_code: null,
      payer_claim_control_number: null,
      corrects_claim_id: null,
      prior_authorization_number: null,
      clearinghouse: null,
      submitted_at: null,
      is_hidden: false,
    }));
  }

  if (/^insert into claim_events/.test(q)) {
    insertRow('claim_events', {
      practice_id: params[0],
      claim_id: params[1],
      created_by: params[2],
      event_type: params[3],
      status_from: params[4],
      status_to: params[5],
      note: params[6],
    });
    return none();
  }

  if (/^insert into claim_acknowledgments/.test(q)) {
    insertRow('claim_acknowledgments', {
      practice_id: params[0],
      claim_id: params[1],
      source: params[2],
      kind: params[3],
      control_number: params[4],
    });
    return none();
  }

  throw new Error(`db mock: unexpected INSERT: ${sql}`);
}

function routeUpdate(q, sql, params) {
  // --- intake save-details: coalesce(nullif($n, ''), col) on every column ---
  if (/^update clients set date_of_birth = coalesce/.test(q)) {
    const c = store.clients.find((r) => r.id === params[8] && !r.is_hidden);
    if (!c) return none();
    c.date_of_birth = keepIfBlank(params[0], c.date_of_birth);
    c.gender = keepIfBlank(params[1], c.gender);
    c.address_line1 = keepIfBlank(params[2], c.address_line1);
    c.address_line2 = keepIfBlank(params[3], c.address_line2);
    c.city = keepIfBlank(params[4], c.city);
    c.state = keepIfBlank(params[5], c.state);
    c.postal_code = keepIfBlank(params[6], c.postal_code);
    c.phone = keepIfBlank(params[7], c.phone);
    return one({ practice_id: c.practice_id });
  }

  // --- PATCH /clients/{id}: handler-built SET list ---
  const clientUpd = q.match(
    /^update clients set (.+) where id = \$(\d+) and practice_id = \$(\d+) and is_hidden = false returning \*$/
  );
  if (clientUpd) {
    const c = store.clients.find(
      (r) => r.id === params[Number(clientUpd[2]) - 1] &&
             r.practice_id === params[Number(clientUpd[3]) - 1] && !r.is_hidden
    );
    if (!c) return none();
    Object.assign(c, parseSets(clientUpd[1], params));
    return one(c);
  }

  // --- claims: patient control number (idempotent coalesce) ---
  if (/^update claims set patient_control_number = coalesce/.test(q)) {
    const c = store.claims.find((r) => r.id === params[1] && r.practice_id === params[2]);
    if (!c) return none();
    if (c.patient_control_number == null) c.patient_control_number = params[0];
    return one({ patient_control_number: c.patient_control_number });
  }

  // --- claims: record the submission attempt BEFORE the network call ---
  if (/^update claims set status = 'submitted'/.test(q)) {
    const c = store.claims.find(
      (r) => r.id === params[3] && r.practice_id === params[4] && !r.is_hidden && r.status === 'draft'
    );
    if (!c) return none();
    Object.assign(c, {
      status: 'submitted',
      submitted_at: 'NOW',
      control_number: null,
      clearinghouse: params[0],
      submission_frequency_code: params[1],
      prior_authorization_number: params[2],
    });
    return one(c);
  }

  // --- claims: clearinghouse rejected → back to draft ---
  if (/^update claims set status = 'draft'/.test(q)) {
    const c = store.claims.find(
      (r) => r.id === params[0] && r.practice_id === params[1] && !r.is_hidden &&
             r.status === 'submitted' && r.control_number == null
    );
    if (!c) return none();
    Object.assign(c, { status: 'draft', submitted_at: null });
    return one({ id: c.id });
  }

  // --- claims: confirmed accepted → fill in the acknowledgment ---
  if (/^update claims set control_number = \$1, claim_number = coalesce/.test(q)) {
    const c = store.claims.find(
      (r) => r.id === params[3] && r.practice_id === params[4] && !r.is_hidden &&
             r.status === 'submitted' && r.control_number == null
    );
    if (!c) return none();
    Object.assign(c, {
      control_number: params[0],
      claim_number: c.claim_number || params[1],
      clearinghouse_payload: params[2],
    });
    return one(c);
  }

  throw new Error(`db mock: unexpected UPDATE: ${sql}`);
}

function route(sql, params) {
  const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
  const bound = params || [];
  if (q.startsWith('select')) return routeSelect(q, sql, bound);
  if (q.startsWith('insert')) return routeInsert(q, sql, bound);
  if (q.startsWith('update')) return routeUpdate(q, sql, bound);
  throw new Error(`db mock: unexpected query: ${sql}`);
}

// --- module mocks ------------------------------------------------------------

mock('lib/db.js', {
  query: async (sql, params) => route(sql, params),
  withTransaction: async (fn) => fn({ query: async (sql, params) => route(sql, params) }),
});

const audits = [];
mock('lib/audit.js', {
  audit: async (event, authCtx, entry) => { audits.push(entry); },
  sanitizeFields: (x) => (x ? Object.keys(x) : []),
});

// Staff credential: one practice admin, resolved from the users table above.
mock('lib/auth.js', {
  requireAuth: () => ({ user: { sub: CLINICIAN_ID, practice_id: PRACTICE_ID, role: 'practice_admin' } }),
  AuthError: class AuthError extends Error {},
});

// The patient's only credential is the signed link token.
const realPaymentToken = require(path.join(__dirname, '..', 'lib', 'payment_token.js'));
let tokenClientId = null;
mock('lib/payment_token.js', {
  ...realPaymentToken,
  verify: (t) => {
    if (t !== LINK_TOKEN) throw new Error('bad token');
    return { client_id: tokenClientId };
  },
});

// Recording adapter: captures the context submit hands it, so "the submit path
// reaches the adapter with the billable facts" is asserted on real arguments.
const adapter = { calls: [], mode: 'ok' };
mock('lib/clearinghouse/index.js', {
  getClearinghouse: () => ({
    name: 'stedi',
    testSubmissionsAllowed: () => false,
    submitClaim: async (ctx) => {
      adapter.calls.push(ctx);
      if (adapter.mode === 'build_error') {
        // What the real adapter does when it cannot build the 837P: a plain
        // Error (no isRejection), which the handler treats as an UNKNOWN outcome.
        throw new Error('Stedi submit requires insurance.payer_id (tradingPartnerServiceId).');
      }
      return {
        control_number: 'CN-000123',
        claim_number: 'CN-000123',
        status: 'submitted',
        raw: { acknowledgment: 'accepted' },
      };
    },
  }),
});

// --- handlers under test (loaded after the mocks are installed) --------------

const clientsHandler = require(path.join(__dirname, '..', 'handlers', 'clients.js')).handler;
const cardSetupHandler = require(path.join(__dirname, '..', 'handlers', 'card_setup.js')).handler;
const sessionsHandler = require(path.join(__dirname, '..', 'handlers', 'sessions.js')).handler;
const claimsHandler = require(path.join(__dirname, '..', 'handlers', 'claims.js')).handler;
const stedi = require(path.join(__dirname, '..', 'lib', 'clearinghouse', 'stedi.js'));

// --- request helpers ---------------------------------------------------------

const body = (res) => JSON.parse(res.body);

function apiEvent(method, routeKey, opts) {
  const o = opts || {};
  return {
    requestContext: { http: { method, path: o.path || '/' }, routeKey },
    pathParameters: o.id ? { id: o.id } : undefined,
    queryStringParameters: o.query || undefined,
    headers: { authorization: 'Bearer staff-token' },
    body: o.body ? JSON.stringify(o.body) : undefined,
  };
}

const postClient = (b) => clientsHandler(apiEvent('POST', 'POST /clients', { body: b }));
const patchClient = (id, b) => clientsHandler(apiEvent('PATCH', 'PATCH /clients/{id}', { id, body: b }));
const postSession = (b) => sessionsHandler(apiEvent('POST', 'POST /sessions', { body: b }));
const postClaim = (b) => claimsHandler(apiEvent('POST', 'POST /claims', { body: b }));
const listClaims = () => claimsHandler(apiEvent('GET', 'GET /claims', {}));
const submitClaim = (id, b) =>
  claimsHandler(apiEvent('POST', 'POST /claims/{id}/submit', { id, body: b || { confirmed: true } }));

const intake = (step, b) =>
  cardSetupHandler({
    requestContext: { http: { method: 'POST', path: `/card-setup/${step}` } },
    rawPath: `/card-setup/${step}`,
    body: JSON.stringify({ token: LINK_TOKEN, ...b }),
  });

// --- the chain ---------------------------------------------------------------

// Walk onboarding → draft claim and return the ids. `opts` perturbs exactly one
// link so the negative cases differ from the happy path in one variable only.
async function runChain(opts) {
  const o = opts || {};

  // 1. Staff create the patient from a name and a phone number. Nothing else is
  //    known yet — the patient supplies the rest through the SMS intake link.
  const created = await postClient({
    first_name: 'Jamie',
    last_name: 'Rivera',
    phone: '(303) 555-0142',
    primary_clinician_id: CLINICIAN_ID,
  });
  assert.strictEqual(created.statusCode, 201, 'POST /clients creates the patient');
  const client = body(created).client;
  assert.strictEqual(client.status, 'awaiting_info', 'a new client starts awaiting_info');
  tokenClientId = client.id;

  // 2. Intake, step one: the patient's own demographics.
  const details = await intake('save-details', {
    date_of_birth: o.dateOfBirth === null ? '' : '1990-08-01',
    gender: 'female',
    address_line1: '5 Elm St',
    city: 'Denver',
    state: 'CO',
    postal_code: '80203',
  });
  assert.strictEqual(details.statusCode, 200, 'save-details accepted');

  // 3. Intake, step two: the patient's own coverage, including the payer id that
  //    routes the claim (only a directory PICK yields one).
  const insurance = await intake('save-insurance', {
    carrier_name: 'Aetna',
    member_id: 'W123456789',
    subscriber_relationship: 'self',
    ...(o.payerId === null
      ? { payer_not_listed: true }        // the "can't find my insurer" escape hatch
      : { payer_id: '60054' }),
  });
  assert.strictEqual(insurance.statusCode, 200, 'save-insurance accepted');

  // THE CENTRAL INTAKE GUARANTEE: a complete intake does not make anyone
  // billable. The chart is populated and the client is still awaiting_info.
  const afterIntake = store.clients.find((c) => c.id === client.id);
  assert.strictEqual(afterIntake.status, 'awaiting_info',
    'a complete intake leaves the client awaiting_info — only a clinician confirms');
  assert.strictEqual(afterIntake.city, 'Denver', "the patient's answers landed on the chart");
  assert.ok(store.insurance_records.length === 1, 'the coverage landed on the chart');

  // 4. The clinician confirms on the chart ("Save as default") — an ordinary
  //    authenticated PATCH. This is what makes the client billable.
  const confirmed = await patchClient(client.id, { status: 'active' });
  assert.strictEqual(confirmed.statusCode, 200, 'the clinician confirm is accepted');
  assert.strictEqual(body(confirmed).client.status, 'active', 'confirm promotes to active');

  // 5. A session carrying the billable facts: CPT, diagnosis, fee.
  const sessionRes = await postSession({
    client_id: client.id,
    clinician_id: CLINICIAN_ID,
    session_date: '2026-06-01',
    duration_minutes: 53,
    cpt_code: o.cptCode === null ? null : '90837',
    diagnosis_codes: o.diagnosisCodes === null ? null : ['F411'],
    place_of_service: o.placeOfService === undefined ? '10' : o.placeOfService,
    fee: o.fee === null ? null : 150,
  });
  assert.strictEqual(sessionRes.statusCode, 201, 'POST /sessions creates the session');
  const session = body(sessionRes).session;

  // 6. The draft claim, built from that session.
  const claimRes = await postClaim({ session_id: session.id });
  assert.strictEqual(claimRes.statusCode, 201, 'POST /claims creates the draft claim');
  const claim = body(claimRes).claim;
  assert.strictEqual(claim.status, 'draft', 'a new claim starts as a draft');

  return { client, session, claim };
}

// Blank the practice's billing address / detach the claim's coverage AFTER the
// chain, so those cases share one setup path with the happy case.
function claimRow(id) {
  return store.claims.find((c) => c.id === id);
}

// --- tests -------------------------------------------------------------------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ===========================================================================
// Part A — the happy path, end to end
// ===========================================================================

test('onboarding → intake → confirm → session → claim → submit', async () => {
  resetStore();
  adapter.calls.length = 0;
  adapter.mode = 'ok';

  const { session, claim } = await runChain();

  // The claim inherited the session's fee and auto-picked the client's coverage.
  assert.strictEqual(Number(claim.billed_amount), 150, 'billed amount comes from the session fee');
  assert.ok(claim.insurance_record_id, 'the claim auto-picked the primary insurance record');
  assert.strictEqual(claim.insurance_record_id, store.insurance_records[0].id,
    'and it is the record intake created');

  // GET /claims — the readiness projection agrees the claim is submittable, and
  // the row carries the four billable facts a human verifies.
  const list = await listClaims();
  assert.strictEqual(list.statusCode, 200, 'GET /claims succeeds');
  const row = body(list).claims.find((r) => r.id === claim.id);
  assert.ok(row, 'the draft claim appears in the list');
  assert.deepStrictEqual(row.readiness.blockers, [], 'no readiness blockers');
  assert.deepStrictEqual(row.readiness.warnings, [], 'no readiness warnings');
  assert.strictEqual(row.readiness.state, 'ready_to_review', 'readiness passes');
  assert.strictEqual(Number(row.billed_amount), 150, 'row carries the billed amount');
  assert.strictEqual(row.cpt_code, '90837', 'row carries the CPT code');
  assert.deepStrictEqual(row.diagnosis_codes, ['F411'], 'row carries the diagnosis');
  assert.strictEqual(row.payer_id, '60054', 'row carries the payer id');

  // Submit reaches the clearinghouse adapter, and the context it receives carries
  // every billable fact the 837P is built from.
  const submitted = await submitClaim(claim.id);
  assert.strictEqual(submitted.statusCode, 200, 'submit succeeds on the happy path');
  assert.strictEqual(adapter.calls.length, 1, 'the submit path reached the adapter exactly once');

  const ctx = adapter.calls[0];
  assert.strictEqual(Number(ctx.claim.billed_amount), 150, 'adapter got the billed amount');
  assert.strictEqual(ctx.session.cpt_code, '90837', 'adapter got the CPT code');
  assert.deepStrictEqual(ctx.session.diagnosis_codes, ['F411'], 'adapter got the diagnosis');
  assert.strictEqual(ctx.insurance.payer_id, '60054', 'adapter got the payer id');
  assert.strictEqual(ctx.session.id, session.id, 'adapter got this claim’s session');
  assert.strictEqual(ctx.client.date_of_birth, '1990-08-01', 'adapter got the subscriber DOB');
  assert.strictEqual(ctx.practice.address_line1, '1 Main St', 'adapter got the billing address');
  assert.ok(ctx.claim.patient_control_number, 'the patient control number was minted before the call');

  // The claim is durably recorded as submitted with the clearinghouse's number.
  const after = claimRow(claim.id);
  assert.strictEqual(after.status, 'submitted', 'claim is submitted');
  assert.strictEqual(after.control_number, 'CN-000123', 'control number recorded');
  assert.strictEqual(after.clearinghouse, 'stedi', 'clearinghouse recorded');
  assert.strictEqual(after.submission_frequency_code, '1', 'filed as an original (frequency 1)');
  assert.strictEqual(store.claim_acknowledgments.length, 1, 'the 277CA was stored verbatim');

  // The whole chain is auditable.
  const actions = audits.map((a) => a.action);
  for (const action of ['client.create', 'client.update', 'session.create', 'claim.create', 'claim.submit']) {
    assert.ok(actions.includes(action), `audit trail records ${action}`);
  }
});

// ===========================================================================
// Part B — the negative half: what actually blocks a claim, and what does not
// ===========================================================================

// The three hard blockers that answer 422 and leave the claim untouched. Each
// perturbs one input; everything else is the happy path.
const HARD_BLOCKERS = [
  {
    name: 'client date of birth',
    chain: { dateOfBirth: null },
    match: /Client date of birth is required/,
  },
  {
    name: 'practice billing address',
    chain: { practiceAddress: null },
    match: /Practice billing address is required/,
  },
  {
    name: 'session place of service',
    // A code that was valid enough to store before the handler validated it.
    chain: {},
    corrupt: (ids) => { store.sessions.find((s) => s.id === ids.session.id).place_of_service = 'office'; },
    match: /place of service is not a valid CMS code/,
  },
];

for (const c of HARD_BLOCKERS) {
  test(`blocked 422 and stays draft — missing/invalid ${c.name}`, async () => {
    resetStore(c.chain);
    adapter.calls.length = 0;
    adapter.mode = 'ok';

    const ids = await runChain(c.chain);
    if (c.corrupt) c.corrupt(ids);

    const res = await submitClaim(ids.claim.id);
    assert.strictEqual(res.statusCode, 422, 'submit is refused with 422');
    assert.match(body(res).error, c.match, 'and says which field to fix');
    assert.strictEqual(adapter.calls.length, 0, 'the clearinghouse was never called');

    const after = claimRow(ids.claim.id);
    assert.strictEqual(after.status, 'draft', 'the claim stays draft');
    assert.strictEqual(after.submitted_at, null, 'and was never marked submitted');
    assert.strictEqual(after.control_number, null, 'and has no control number');
  });
}

test('blocked 400 and stays draft — no insurance record attached', async () => {
  resetStore();
  adapter.calls.length = 0;

  const ids = await runChain();
  // Detach coverage the way a hidden/deleted insurance record would.
  claimRow(ids.claim.id).insurance_record_id = null;

  const res = await submitClaim(ids.claim.id);
  // 400 rather than 422: this blocker predates the context blockers and runs
  // BEFORE the patient control number is minted, so nothing is mutated.
  assert.strictEqual(res.statusCode, 400, 'submit is refused with 400');
  assert.match(body(res).error, /Attach an insurance record before submitting/);
  assert.strictEqual(adapter.calls.length, 0, 'the clearinghouse was never called');

  const after = claimRow(ids.claim.id);
  assert.strictEqual(after.status, 'draft', 'the claim stays draft');
  assert.strictEqual(after.patient_control_number, null,
    'and the blocked submit never minted a control number');
});

test('readiness projection refuses the same claims the gate refuses', async () => {
  // The projection is a composition of the gate's checks, so the list must not
  // say "ready" about a claim submit would reject.
  for (const c of [{ dateOfBirth: null }, { practiceAddress: null }]) {
    resetStore(c);
    const ids = await runChain(c);
    const row = body(await listClaims()).claims.find((r) => r.id === ids.claim.id);
    assert.strictEqual(row.readiness.state, 'needs_correction',
      `readiness flags ${JSON.stringify(c)} as needs_correction`);
    assert.ok(row.readiness.blockers.length >= 1, 'and names at least one blocker');
    assert.strictEqual(row.readiness.blockers[0].status, 422, 'reporting the status submit would answer');
  }
});

test('missing payer id is blocked by the gate — 422, claim stays draft', async () => {
  // This case USED to reach the adapter: the gate said nothing about the payer
  // id, so submit moved the claim to 'submitted' and only then failed building
  // the 837P — stranding a never-transmitted claim in a retry-blocked 502. The
  // content blockers close that off ahead of the status transition, so the claim
  // never leaves draft. adapter.mode stays 'build_error' to prove the point: even
  // primed to fail, the adapter is never reached.
  resetStore();
  adapter.calls.length = 0;
  adapter.mode = 'build_error';

  // The escape hatch ("I can't find my insurer") saves coverage with no payer id.
  const ids = await runChain({ payerId: null });
  assert.strictEqual(store.insurance_records[0].payer_id, null, 'coverage saved without a payer id');

  // The projection flags it before anyone clicks submit, naming the status submit
  // would answer.
  const row = body(await listClaims()).claims.find((r) => r.id === ids.claim.id);
  assert.strictEqual(row.readiness.state, 'needs_correction', 'a modeled blocker objects');
  assert.strictEqual(row.payer_id, null, 'and the row shows the payer id is missing');
  const payerBlocker = row.readiness.blockers.find((b) => b.code === 'insurance_payer_id');
  assert.ok(payerBlocker, 'the blocker names the payer id');
  assert.strictEqual(payerBlocker.status, 422, 'reporting the status submit would answer');

  const res = await submitClaim(ids.claim.id);
  assert.strictEqual(res.statusCode, 422, 'submit is refused with 422');
  assert.match(body(res).error, /no routable payer ID/, 'and says which field to fix');
  assert.strictEqual(adapter.calls.length, 0, 'the clearinghouse was never called');

  const after = claimRow(ids.claim.id);
  assert.strictEqual(after.status, 'draft', 'the claim stays draft');
  assert.strictEqual(after.submitted_at, null, 'and was never marked submitted');
  assert.strictEqual(after.control_number, null, 'and has no control number');
  // The 422 blockers run AFTER the patient control number is minted, so a blocked
  // submit does leave that one field written. Harmless and deliberate: the PCN is a
  // stable per-claim id, minted with a coalesce and reused by every later
  // submission of this claim, so the eventual real submit carries the same value.
  // (The 400 "no insurance attached" case above predates minting and leaves it null.)
  assert.ok(after.patient_control_number, 'the control number minted before the gate is kept');

  // The adapter's own refusal survives as a BACKSTOP for direct callers — normal
  // flow no longer reaches it, but it must still refuse a payer-less claim.
  assert.throws(
    () => stedi.buildSubmissionBody({
      claim: { billed_amount: '150.00', patient_control_number: 'PCN1' },
      insurance: { member_id: 'W123456789' },   // no payer_id
      client: {}, clinician: {}, practice: {}, session: {},
    }),
    /requires insurance\.payer_id/,
    'the 837P builder still refuses a payer-less claim'
  );
});

test('coverage hidden after the claim was created — 422, claim stays draft', async () => {
  // The same stranding as the payer-id case, reached by a different route. Here
  // the coverage was complete when the claim was created and is soft-deleted
  // afterwards (staff correcting a duplicate insurance record). The claim still
  // POINTS at it, so the id-only missing-insurance check passes; the load filters
  // is_hidden so the record comes back null, and the payer-id check abstains on a
  // null record. The claim then reached the builder with no coverage at all and
  // threw locally — after the status transition, stranding a claim that was never
  // transmitted. adapter.mode stays 'build_error' to prove the adapter is never
  // reached now.
  resetStore();
  adapter.calls.length = 0;
  adapter.mode = 'build_error';

  const ids = await runChain();
  const record = store.insurance_records[0];
  assert.strictEqual(record.payer_id, '60054', 'the coverage was complete when the claim was created');
  assert.strictEqual(claimRow(ids.claim.id).insurance_record_id, record.id,
    'and the claim points at it');

  // Staff soft-delete the record afterwards.
  record.is_hidden = true;

  // The projection stops calling the claim ready the moment its coverage vanishes.
  const row = body(await listClaims()).claims.find((r) => r.id === ids.claim.id);
  assert.strictEqual(row.readiness.state, 'needs_correction',
    'a claim whose coverage vanished is not "ready"');
  const blocker = row.readiness.blockers.find((b) => b.code === 'insurance_unresolvable');
  assert.ok(blocker, 'the blocker names the vanished coverage');
  assert.strictEqual(blocker.status, 422, 'reporting the status submit would answer');
  // It does not misreport the cause: the payer id is unreadable, not missing.
  assert.ok(!row.readiness.blockers.some((b) => b.code === 'insurance_payer_id'),
    'and does not blame the payer id it can no longer read');

  const res = await submitClaim(ids.claim.id);
  assert.strictEqual(res.statusCode, 422, 'submit is refused with 422');
  assert.match(body(res).error, /insurance record is no longer available/,
    'and says what to fix, in plain English');
  assert.strictEqual(adapter.calls.length, 0, 'the clearinghouse was never called');

  const after = claimRow(ids.claim.id);
  assert.strictEqual(after.status, 'draft', 'the claim stays draft');
  assert.strictEqual(after.submitted_at, null, 'and was never marked submitted');
  assert.strictEqual(after.control_number, null, 'and has no control number');
});

test('blocked 422 and stays draft — no billed amount, CPT, or diagnosis', async () => {
  // The billable content the claim actually charges for. A claim missing all
  // three once transmitted: it billed nothing, carried no procedure code, and
  // would have gone out with a fabricated placeholder diagnosis. All three are
  // hard blockers now, evaluated while the claim is still editable.
  resetStore();
  adapter.calls.length = 0;
  adapter.mode = 'ok';

  const ids = await runChain({ fee: null, cptCode: null, diagnosisCodes: null });
  assert.strictEqual(claimRow(ids.claim.id).billed_amount, null, 'the claim carries no amount');

  const row = body(await listClaims()).claims.find((r) => r.id === ids.claim.id);
  assert.strictEqual(row.readiness.state, 'needs_correction',
    'readiness models the billable facts and objects to all three');
  assert.strictEqual(row.cpt_code, null);
  assert.strictEqual(row.diagnosis_codes, null);

  // Each missing fact is named separately, so the list tells you everything to
  // fix rather than one thing at a time.
  const codes = row.readiness.blockers.map((b) => b.code);
  for (const code of ['claim_billed_amount', 'session_cpt_code', 'claim_diagnosis_codes']) {
    assert.ok(codes.includes(code), `readiness names ${code}`);
  }

  const res = await submitClaim(ids.claim.id);
  assert.strictEqual(res.statusCode, 422, 'submit is refused with 422');
  // Blockers are emitted in submit's order, so the first one is what submit answers.
  assert.match(body(res).error, /no billed amount/, 'answering with the first blocker');
  assert.strictEqual(row.readiness.blockers[0].code, 'claim_billed_amount',
    'and the projection agrees on which blocker that is');
  assert.strictEqual(adapter.calls.length, 0, 'the clearinghouse was never called');

  const after = claimRow(ids.claim.id);
  assert.strictEqual(after.status, 'draft', 'the claim stays draft');
  assert.strictEqual(after.submitted_at, null, 'and was never marked submitted');
  assert.strictEqual(after.control_number, null, 'and has no control number');
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
      console.error('FAIL  ' + t.name + '\n      ' + (err && err.stack));
    }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
