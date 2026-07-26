/* Reddably API client — the single entry point for all network calls.
 * Views must use window.ReddablyAPI and never call fetch() directly.
 *
 * Auth token is stored in localStorage under "reddably_access_token".
 * No PHI is ever placed in URLs or query strings (ids/status enums only).
 */
(function (window) {
  'use strict';

  // API base URL — configurable so the domain can be flipped with zero code edits.
  // Resolution order (first match wins):
  //   1. window.REDDABLY_API_BASE  — global set by an inline/injected bootstrap snippet
  //   2. <meta name="reddably-api-base" content="https://api.claimsub.com">
  //   3. default below (the current live, canonical hostname)
  function resolveApiBase() {
    if (window.REDDABLY_API_BASE) return window.REDDABLY_API_BASE;
    try {
      var meta = window.document.querySelector('meta[name="reddably-api-base"]');
      if (meta && meta.content) return meta.content;
    } catch (e) {
      /* document unavailable — fall through to default */
    }
    return 'https://api.claims.sessionably.com';
  }

  var API_BASE = resolveApiBase();

  // Base URL for the patient-billing endpoints, which run as Vercel functions
  // (Stripe/Twilio need outbound internet the VPC Lambda API lacks), NOT on the
  // Lambda API at API_BASE.
  //
  // These functions ship in the same Vercel project that serves this page, so the
  // app's own origin is always the correct base: the calls stay same-origin (no CORS
  // preflight to get wrong), and a preview deployment or a local server hits its OWN
  // functions instead of billing through production. A hardcoded host cannot satisfy
  // both, and getting it wrong is silent — a cross-origin POST that never arrives
  // still looks like a fired request from the calling code.
  //
  // Overridable via window.REDDABLY_VERCEL_BASE or <meta name="reddably-vercel-base">
  // for the one case the origin can't cover: the app being served from somewhere that
  // does not host /api. The final fallback is for non-browser/file:// contexts, where
  // location.origin is absent or the string "null".
  function resolveVercelBase() {
    if (window.REDDABLY_VERCEL_BASE) return window.REDDABLY_VERCEL_BASE;
    try {
      var meta = window.document.querySelector('meta[name="reddably-vercel-base"]');
      if (meta && meta.content) return meta.content;
      var origin = window.location && window.location.origin;
      if (origin && origin !== 'null') return origin;
    } catch (e) {
      /* document/location unavailable — fall through to default */
    }
    return 'https://claims.sessionably.com';
  }

  var VERCEL_BASE = resolveVercelBase();
  var TOKEN_KEY = 'reddably_access_token';

  // Dispatched on window when a platform-fee charge does not complete. The claim is
  // already submitted and stays submitted; this only tells the shell to warn staff that
  // the fee needs a manual follow-up. detail: { claim_id, reason } — ids and error
  // strings only, never PHI.
  var FEE_CHARGE_FAILED_EVENT = 'reddably:fee-charge-failed';

  // --- token storage ---------------------------------------------------------

  function getToken() {
    try {
      return window.localStorage.getItem(TOKEN_KEY);
    } catch (e) {
      return null;
    }
  }

  function setToken(token) {
    try {
      if (token) window.localStorage.setItem(TOKEN_KEY, token);
    } catch (e) {
      /* storage unavailable (private mode) — ignore */
    }
  }

  function clearToken() {
    try {
      window.localStorage.removeItem(TOKEN_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  // Decode a JWT payload without verifying the signature (client-side hint only).
  function decodeJwt(token) {
    if (!token) return null;
    var parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
      var base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      var padded = base64 + '==='.slice((base64.length + 3) % 4);
      return JSON.parse(window.atob(padded));
    } catch (e) {
      return null;
    }
  }

  // True only if a token is present and its exp is in the future.
  function isAuthenticated() {
    var payload = decodeJwt(getToken());
    if (!payload || !payload.exp) return false;
    return payload.exp * 1000 > Date.now();
  }

  // --- core request helper ---------------------------------------------------

  // `base` defaults to the Lambda API (API_BASE); pass VERCEL_BASE for the
  // patient-billing endpoints that run as Vercel functions.
  function request(method, path, body, base) {
    var headers = { 'Content-Type': 'application/json' };
    var token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    var opts = { method: method, headers: headers };
    if (body !== undefined && body !== null) {
      opts.body = JSON.stringify(body);
    }

    return window.fetch((base || API_BASE) + path, opts).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (!res.ok) {
            var err = new Error((data && data.error) || 'Request failed');
            err.status = res.status;
            err.body = data;
            throw err;
          }
          return data;
        });
    });
  }

  // Build a "?a=1&b=2" string from a params object, skipping null/undefined/''.
  // Values are encoded; only non-PHI identifiers/enums are ever passed here.
  function buildQuery(params) {
    if (!params) return '';
    var parts = [];
    Object.keys(params).forEach(function (key) {
      var v = params[key];
      if (v === null || v === undefined || v === '') return;
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(v));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  // --- auth methods ----------------------------------------------------------

  // register(payload) -> POST /register; stores token on success.
  function register(payload) {
    return request('POST', '/register', payload).then(function (res) {
      if (res && res.token) setToken(res.token);
      return res;
    });
  }

  function login(email, password) {
    return request('POST', '/login', { email: email, password: password }).then(function (res) {
      if (res && res.token) setToken(res.token);
      return res;
    });
  }

  function logout() {
    clearToken();
  }

  function me() {
    return request('GET', '/me');
  }

  // --- resource methods ------------------------------------------------------
  // Each method resolves to the backend's response object as-is, e.g.
  //   clients.list()        -> { clients: [...] }
  //   clients.get(id)       -> { client: {...} }
  //   claims.events(id)     -> { claim_events: [...] }
  // Views read the named field off the result. Errors reject with an Error whose
  // .status and .body carry the HTTP status and parsed error payload.

  var clients = {
    list: function () { return request('GET', '/clients'); },
    get: function (id) { return request('GET', '/clients/' + id); },
    create: function (payload) { return request('POST', '/clients', payload); },
    update: function (id, payload) { return request('PATCH', '/clients/' + id, payload); },
    remove: function (id) { return request('DELETE', '/clients/' + id); },
    // Text the client an SMS link to securely save a payment method (staff action).
    // Runs as a Vercel function (Twilio egress) → target VERCEL_BASE.
    sendPaymentLink: function (id) {
      return request('POST', '/clients/' + id + '/send-payment-link', {}, VERCEL_BASE);
    },
  };

  // Patient billing (PUBLIC endpoints — used by the standalone card-capture page).
  // These take a short-lived signed token in the body, not the staff bearer token,
  // and run as Vercel functions (Stripe egress) → target VERCEL_BASE.
  var billing = {
    // Resolve the client behind the signed token (first/last name, email) so the
    // intake page can address the patient by name. Hits the Lambda API (card_setup
    // handler) directly — the token is the credential, in the body. No PHI in the
    // URL. -> { client_id, practice_id, first_name, last_name, email, ... }.
    context: function (token) {
      return request('POST', '/card-setup/context', { token: token });
    },
    setupIntent: function (token) {
      return request('POST', '/setup-intent', { token: token }, VERCEL_BASE);
    },
    savePaymentMethod: function (token, paymentMethodId) {
      return request('POST', '/save-payment-method', { token: token, paymentMethodId: paymentMethodId }, VERCEL_BASE);
    },
    // Persist the patient's demographics (date of birth + current address) to the
    // client record so a claim can be built without manual re-entry. Hits the
    // Lambda API (card_setup handler) directly — no Stripe/Twilio egress.
    // fields: { date_of_birth?, phone?, address_line1?, address_line2?, city?, state?, postal_code? }
    saveDetails: function (token, fields) {
      var payload = { token: token };
      Object.keys(fields || {}).forEach(function (k) { payload[k] = fields[k]; });
      return request('POST', '/card-setup/save-details', payload);
    },
    // Persist the patient's OON insurance info. No Stripe/Twilio egress needed, so
    // this hits the Lambda API (card_setup handler) directly — not a Vercel function.
    // fields: { carrier_name, member_id, group_number?, subscriber_relationship?,
    //           subscriber_name?, subscriber_dob?, payer_id? }
    saveInsurance: function (token, fields) {
      var payload = { token: token };
      Object.keys(fields || {}).forEach(function (k) { payload[k] = fields[k]; });
      return request('POST', '/card-setup/save-insurance', payload);
    },
    // Type-ahead payer lookup for the insurance step. The signed token is the
    // credential (in the body, not the staff bearer). q is a free-text
    // payer-name fragment — no PHI. Hits the Lambda API (card_setup handler)
    // directly, like saveInsurance. -> { payers: [{ name, payer_id, stedi_id }] }.
    searchPayers: function (token, q) {
      return request('POST', '/card-setup/payer-search', { token: token, q: q });
    },
  };

  var insuranceRecords = {
    // filters: { client_id }
    list: function (filters) { return request('GET', '/insurance-records' + buildQuery(filters)); },
    get: function (id) { return request('GET', '/insurance-records/' + id); },
    create: function (payload) { return request('POST', '/insurance-records', payload); },
    update: function (id, payload) { return request('PATCH', '/insurance-records/' + id, payload); },
    remove: function (id) { return request('DELETE', '/insurance-records/' + id); },
  };

  var sessions = {
    // filters: { client_id, clinician_id, status }
    list: function (filters) { return request('GET', '/sessions' + buildQuery(filters)); },
    get: function (id) { return request('GET', '/sessions/' + id); },
    create: function (payload) { return request('POST', '/sessions', payload); },
    update: function (id, payload) { return request('PATCH', '/sessions/' + id, payload); },
    remove: function (id) { return request('DELETE', '/sessions/' + id); },
  };

  // Best-effort: after a claim is submitted, trigger the platform-fee charge on the
  // Vercel function (which has the Stripe egress the Lambda lacks). Fire-and-forget —
  // the claim is already submitted and STAYS submitted, so a fee failure must never
  // block, reverse, or fail the submission. Forwards the staff session JWT so the
  // function can verify it.
  //
  // Best-effort is not the same as silent: a failure emits FEE_CHARGE_FAILED_EVENT so
  // the shell can warn staff that this claim's fee needs a manual follow-up. Revenue
  // that quietly does not bill is the worst possible failure mode here.
  //
  // Reading the outcome takes care, because the function answers 200 in three different
  // situations:
  //   { ok:true,  charged:true  }  — charged. Quiet.
  //   { ok:true,  charged:false }  — nothing to charge (fee waived, practice-paid, no
  //                                  card on file). Legitimate; quiet.
  //   { ok:false, charged:false }  — the charge itself failed, e.g. an off-session card
  //                                  decline. res.ok is TRUE here, so the body — not the
  //                                  HTTP status — is what decides.
  function chargeClaimFee(id) {
    function failed(reason) {
      console.warn('Platform fee charge did not complete for claim ' + id + ': ' + reason);
      try {
        window.dispatchEvent(new window.CustomEvent(FEE_CHARGE_FAILED_EVENT, {
          detail: { claim_id: id, reason: reason },
        }));
      } catch (e) {
        /* CustomEvent unavailable — the console warning above is the only trace */
      }
    }

    try {
      var token = getToken();
      if (!token) return;
      window.fetch(VERCEL_BASE + '/api/claims/' + id + '/charge-fee', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: '{}',
      }).then(function (res) {
        return res.json().catch(function () {
          return {};
        }).then(function (data) {
          if (!res.ok) {
            failed((data && data.error) || ('HTTP ' + res.status));
            return;
          }
          if (data && data.ok === false) {
            failed(data.fee_charge_error || 'charge failed');
          }
        });
      }).catch(function (e) {
        // Transport-level: DNS, CORS, offline — the request never reached the function.
        failed((e && e.message) || 'network error');
      });
    } catch (e) {
      /* never throw from a best-effort fee charge */
    }
  }

  var claims = {
    // filters: { session_id, client_id, status }
    list: function (filters) { return request('GET', '/claims' + buildQuery(filters)); },
    get: function (id) { return request('GET', '/claims/' + id); },
    create: function (payload) { return request('POST', '/claims', payload); },
    update: function (id, payload) { return request('PATCH', '/claims/' + id, payload); },
    remove: function (id) { return request('DELETE', '/claims/' + id); },
    // lifecycle actions. submit(id, { confirmed }) — pass confirmed:true to
    // proceed past the server's soft pre-submission warnings. Without it, a claim
    // that trips a warning comes back { requires_confirmation:true, warnings:[…] }
    // and is NOT submitted (so no fee is charged).
    submit: function (id, opts) {
      var payload = opts && opts.confirmed ? { confirmed: true } : {};
      return request('POST', '/claims/' + id + '/submit', payload).then(function (res) {
        // Only charge the platform fee when the claim was actually submitted —
        // never on the warning gate. Best-effort via Vercel; never blocks submit.
        //
        // A REPLACEMENT (frequency 7) claim NEVER charges the fee: it supersedes a
        // claim on which the fee was already collected, so charging again would bill
        // the patient another 5% for the same service. Skip the call here (the
        // Lambda charge-fee/context also refuses it, so this is defense in depth).
        var claim = res && res.claim;
        var isReplacement = !!claim &&
          (claim.submission_frequency_code === '7' || claim.corrects_claim_id != null);
        if (!res || (!res.requires_confirmation && !isReplacement)) chargeClaimFee(id);
        return res;
      });
    },
    refresh: function (id) { return request('POST', '/claims/' + id + '/refresh', {}); },
    void: function (id) { return request('POST', '/claims/' + id + '/void', {}); },
    // Recompute a draft/denied claim's session-derived fields (billed amount)
    // after its underlying session was edited. Server-side; no client-side math.
    regenerate: function (id) { return request('POST', '/claims/' + id + '/regenerate', {}); },
    events: function (id) { return request('GET', '/claims/' + id + '/events'); },
    // Create a CMS frequency-7 REPLACEMENT of an accepted claim. `id` is the
    // original (payer-accepted) claim; returns a NEW draft claim carrying the
    // replacement intent, which the operator then submits (with a confirm dialog).
    // payload: { payer_claim_control_number } — the payer's original claim number.
    replace: function (id, payload) { return request('POST', '/claims/' + id + '/replace', payload); },
  };

  var users = {
    // filters: { role, is_active }
    list: function (filters) { return request('GET', '/users' + buildQuery(filters)); },
    get: function (id) { return request('GET', '/users/' + id); },
    update: function (id, payload) { return request('PATCH', '/users/' + id, payload); },
  };

  // The caller's own practice (settings). get() -> { practice: {...} };
  // update(payload) PUTs identity + billing-address fields. Practice_id is always
  // derived server-side from the token — never sent in the payload.
  var practice = {
    get: function () { return request('GET', '/practice'); },
    update: function (payload) { return request('PUT', '/practice', payload); },
  };

  var invitations = {
    list: function () { return request('GET', '/invitations'); },
    create: function (payload) { return request('POST', '/invitations', payload); },
    revoke: function (id) { return request('DELETE', '/invitations/' + id); },
  };

  // De-identified calendar feed (per-user read-only ICS). settings() returns the
  // caller's { feed_token, feed_url }; regenerate() rotates the token, instantly
  // revoking the old feed. The feed itself (GET /calendar/{token}.ics) is fetched
  // by the user's calendar app directly, never through this client.
  var calendar = {
    settings: function () { return request('GET', '/calendar/settings'); },
    regenerate: function () { return request('POST', '/calendar/regenerate', {}); },
  };

  // Staged inbound calendar events (review + promotion to sessions).
  //   list(filters)        -> { calendar_events: [...] }  filters: { state, from, to }
  //   promote(id, clientId)-> { session, calendar_event } (idempotent; creates the
  //                           sessions row on explicit confirmation only)
  //   ignore(id)           -> { ignored: true }  (reversible via promote)
  //   sync()               -> { connections, totals }  (pulls fresh events in;
  //                           the path names the provider internally — UI text
  //                           stays white-labeled as "Calendar" / "Sync now")
  var calendarEvents = {
    list: function (filters) { return request('GET', '/calendar-events' + buildQuery(filters)); },
    promote: function (id, clientId) {
      return request('POST', '/calendar-events/' + id + '/promote', { client_id: clientId });
    },
    ignore: function (id) { return request('POST', '/calendar-events/' + id + '/ignore', {}); },
    sync: function () { return request('POST', '/integrations/google/sync', {}); },
  };

  // Subscription / plan (Instant VOB add-on).
  //   status()      -> { plan, vob_checks_used, vob_period_start }  (Lambda API; DB-only)
  //   activateVob() -> { checkoutUrl }  (Vercel function; Stripe egress) — redirect there
  var subscription = {
    status: function () { return request('GET', '/subscription/status'); },
    activateVob: function () {
      return request('POST', '/subscription/vob/activate', {}, VERCEL_BASE);
    },
  };

  // Instant VOB benefit check (gated by plan; see subscription). Runs on the
  // Lambda API. payload: { memberId, payerId, firstName, lastName, dateOfBirth,
  // insurance_record_id? } -> normalized benefits summary.
  var vob = {
    check: function (payload) { return request('POST', '/vob/check', payload); },
  };

  // Payer directory search (type-ahead). q is a free-text payer-name fragment —
  // no PHI. search(q) -> { payers: [{ name, payer_id, stedi_id }] }.
  var payers = {
    search: function (q) { return request('GET', '/payers/search' + buildQuery({ q: q })); },
  };

  // Per-practice ERA (electronic remittance) enrollments. Practice-scoped from the
  // token; create is practice_admin-only (server-enforced). No PHI.
  //   list()             -> { payer_enrollments: [...], sync_error }
  //   create({payer_id, payer_name}) -> { payer_enrollment: {...} }
  //   sync(id)           -> { payer_enrollment: {...}, sync_error }
  var payerEnrollments = {
    list: function () { return request('GET', '/payer-enrollments'); },
    create: function (payload) { return request('POST', '/payer-enrollments', payload); },
    sync: function (id) { return request('POST', '/payer-enrollments/' + id + '/sync', {}); },
  };

  // Provider billing identity. verifyNpi(npi) checks an NPI against the NPPES
  // registry (no PHI) -> { found, enumerationType, entityType, name, ... } or
  // { found:false }. billingProfile.get/save read+write a provider's per-clinician
  // billing profile (person vs organization). The TIN is only ever sent in the
  // save body (never a URL) and comes back masked. Practice scope is server-side.
  var providers = {
    verifyNpi: function (npi) { return request('POST', '/providers/verify-npi', { npi: npi }); },
    billingProfile: {
      get: function (userId) { return request('GET', '/providers/' + userId + '/billing-profile'); },
      save: function (userId, payload) { return request('PUT', '/providers/' + userId + '/billing-profile', payload); },
    },
  };

  // Practice analytics (Reports view). Server-side aggregation; practice-scoped
  // from the token. filters: { start, end } as YYYY-MM-DD (both optional; non-PHI
  // date bounds only). summary(filters) -> { report: {...} }.
  var reports = {
    summary: function (filters) { return request('GET', '/reports' + buildQuery(filters)); },
  };

  // HIPAA audit log (admin-only; the server enforces the role). Read-only.
  // filters: { from, to, action, resource_type, resource_id, actor_user_id,
  // limit, before } — all optional and non-PHI (ids, enums, dot-notation actions,
  // date bounds). list(filters) -> { audit_log: [...], next_before: <cursor|null> }.
  var auditLog = {
    list: function (filters) { return request('GET', '/audit-log' + buildQuery(filters)); },
  };

  // Patient-initiated fee refunds (admin-only; the server enforces the role).
  //   list(filters)          -> { refund_requests: [...] }   filters: { status }
  //   get(id)                -> { refund_request: {...} }
  //   create({ claim_id, outcome_label, patient_note }) -> { refund_request: {...} }
  //   deny(id, reason)       -> { refund_request: {...} }    (no money moves)
  //   approve(id, reason)    -> { ok, refunded, recorded, refund_request }
  // Only outcome_label 'denied' is refundable; approve() issues the Stripe refund of
  // the 5% fee. approve() runs through the Vercel function (Stripe egress), like the
  // fee charge — every other method hits the Lambda API. Only ids/enums in the path.
  var refunds = {
    list: function (filters) { return request('GET', '/refund-requests' + buildQuery(filters)); },
    get: function (id) { return request('GET', '/refund-requests/' + id); },
    create: function (payload) { return request('POST', '/refund-requests', payload); },
    deny: function (id, reason) { return request('POST', '/refund-requests/' + id + '/deny', { reason: reason }); },
    approve: function (id, reason) {
      return request('POST', '/api/refund-requests/' + id + '/approve', { reason: reason }, VERCEL_BASE);
    },
  };

  window.ReddablyAPI = {
    // config
    API_BASE: API_BASE,
    VERCEL_BASE: VERCEL_BASE,
    FEE_CHARGE_FAILED_EVENT: FEE_CHARGE_FAILED_EVENT,
    // token helpers
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,
    isAuthenticated: isAuthenticated,
    // low-level (other modules may use; views use the named resource methods)
    request: request,
    buildQuery: buildQuery,
    // auth
    register: register,
    login: login,
    logout: logout,
    me: me,
    // resources
    clients: clients,
    insuranceRecords: insuranceRecords,
    sessions: sessions,
    claims: claims,
    users: users,
    practice: practice,
    invitations: invitations,
    calendar: calendar,
    calendarEvents: calendarEvents,
    billing: billing,
    subscription: subscription,
    vob: vob,
    payers: payers,
    payerEnrollments: payerEnrollments,
    providers: providers,
    reports: reports,
    auditLog: auditLog,
    refunds: refunds,
  };
})(window);
