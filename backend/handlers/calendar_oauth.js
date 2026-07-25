'use strict';

// INBOUND Google Calendar sync — OAuth connect/disconnect flow ONLY (no event
// fetching, no matching, no promotion; later changes). One Lambda routed
// internally by the trailing path segment, like the other resources:
//
//   GET  /integrations/google/start       → 302 to the Google consent URL
//   GET  /integrations/google/callback    → code exchange + connection upsert
//   GET  /integrations/google/status      → the caller's connections (no tokens)
//   POST /integrations/google/disconnect  → status 'disconnected' + token cleanup
//
// Unrelated to the OUTBOUND de-identified ICS feed (handlers/calendar.js) —
// these routes live under /integrations/google/* to avoid any collision.
//
// Auth: /start, /status, /disconnect are Bearer-JWT authed (requireAuth). The
// /callback is hit by a BROWSER REDIRECT from Google, which carries no
// Authorization header — it is authenticated by the signed `state` instead: a
// short-lived JWT (same HS256 secret) minted by /start and bound to the
// requesting user. Expiry is the single-use bound — there is deliberately no
// server-side session store to mark a state consumed (see makeState).
//
// Token storage: the OAuth refresh token goes to SSM as a SecureString at
//   /claimsub/prod/google/refresh/{calendar_connections.id}
// — the path is derived from the row's primary key, so NO column stores it.
// The row and its parameter are kept transactional: a failed SSM write rolls
// back a freshly-inserted row, so an active row whose parameter does not exist
// can never be left behind. calendar_connections.refresh_token_ciphertext /
// token_encryption_key_id are deliberately left NULL (a dropped KMS design;
// see the migration-020 header) — do not populate them.
//
// White-labeling: vendor names never appear in user-facing text. Error strings
// returned to the client say "calendar" / "your calendar provider" — never the
// provider's brand. Internal identifiers (routes, column values) may say google.
//
// Security: NEVER log tokens, authorization codes, state values, or the client
// secret. account_email / calendar ids are the clinician's own staff data (no
// PHI), but stay out of logs anyway. Every query is practice- and user-scoped.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const db = require('../lib/db');
const { requireAuth, AuthError } = require('../lib/auth');
const { json, preflight, corsHeaders, DEFAULT_ORIGIN } = require('../lib/response');
const { parseBody } = require('../lib/util');
const { audit } = require('../lib/audit');
const google = require('../lib/google_oauth');
const ssm = require('../lib/ssm');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Where the SecureString refresh tokens live; the connection row id is appended.
const REFRESH_SSM_PREFIX =
  process.env.GOOGLE_REFRESH_SSM_PREFIX || '/claimsub/prod/google/refresh';

function refreshParamPath(connectionId) {
  return `${REFRESH_SSM_PREFIX}/${connectionId}`;
}

// Where the browser lands after the consent round-trip. Non-PHI status flag only.
const APP_RETURN_URL = process.env.CALENDAR_CONNECT_RETURN_URL
  || `${DEFAULT_ORIGIN}/app/app.html`;

// --- state token ---------------------------------------------------------------
// The `state` is a short-lived HS256 JWT signed with the existing JWT_SECRET,
// bound to the requesting user (sub + practice_id) and stamped with a dedicated
// purpose so a stolen SESSION token can never pass as a state (and vice versa —
// a state can never authenticate an API call, since requireAuth checks none of
// this). The nonce makes every value unique; true single-use bookkeeping would
// need a server-side store, which this flow deliberately avoids, so the 10-minute
// expiry is the replay bound.

const STATE_PURPOSE = 'google_calendar_connect';
const STATE_TTL = '10m';

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not set');
  }
  return secret;
}

// makeState(user) -> signed state string. `user` is the decoded auth principal
// ({ sub, practice_id, ... }).
function makeState(user) {
  return jwt.sign(
    {
      sub: user.sub,
      practice_id: user.practice_id,
      purpose: STATE_PURPOSE,
      nonce: crypto.randomBytes(16).toString('hex'),
    },
    jwtSecret(),
    { algorithm: 'HS256', expiresIn: STATE_TTL }
  );
}

// verifyState(state) -> { sub, practice_id } or throws AuthError (401) on a
// missing/tampered/expired state or a token minted for any other purpose.
function verifyState(state) {
  if (!state) {
    throw new AuthError('Missing state');
  }
  let decoded;
  try {
    decoded = jwt.verify(state, jwtSecret(), { algorithms: ['HS256'] });
  } catch (_) {
    // Swallow jwt error detail — don't leak it to the client/logs.
    throw new AuthError('Invalid or expired state');
  }
  if (decoded.purpose !== STATE_PURPOSE || !decoded.sub || !decoded.practice_id) {
    throw new AuthError('Invalid or expired state');
  }
  return { sub: decoded.sub, practice_id: decoded.practice_id };
}

// --- request helpers -------------------------------------------------------------

function httpMethod(event) {
  if (!event) return '';
  if (event.httpMethod) return event.httpMethod;
  const ctx = event.requestContext;
  return (ctx && ctx.http && ctx.http.method) || '';
}

function queryParam(event, name) {
  return event && event.queryStringParameters ? event.queryStringParameters[name] : undefined;
}

// Trailing action segment for /integrations/google/<action>. Reads the v2
// routeKey template first (stable), falling back to the request path.
function action(event) {
  const rk = (event && event.requestContext && event.requestContext.routeKey) || '';
  let m = rk.match(/\/integrations\/google\/([a-z]+)$/i);
  if (m) return m[1].toLowerCase();
  const path =
    (event && event.requestContext && event.requestContext.http && event.requestContext.http.path) ||
    (event && event.rawPath) || '';
  m = path.match(/\/integrations\/google\/([a-z]+)\/?$/i);
  return m ? m[1].toLowerCase() : null;
}

// 302 redirect response (the consent hop and the post-callback return-to-app).
function redirect(location, event) {
  return {
    statusCode: 302,
    headers: { Location: location, ...corsHeaders(event) },
    body: '',
  };
}

// --- routes ---------------------------------------------------------------------

// GET /integrations/google/start — Bearer-authed. Mints the signed state and
// bounces the browser to the consent URL.
async function start(event) {
  const { user } = requireAuth(event);
  const state = makeState(user);
  const url = await google.buildAuthUrl({ state });
  return redirect(url, event);
}

// GET /integrations/google/callback — state-authed (see header). Exchanges the
// code, captures the calendar's own timeZone, upserts the connection row, and
// writes the refresh token to SSM at the row-id-derived path.
async function callback(event) {
  const st = verifyState(queryParam(event, 'state'));
  const authCtx = { userId: st.sub, practiceId: st.practice_id };

  // The clinician declined on the consent screen (or the provider errored).
  if (queryParam(event, 'error')) {
    return json(400, { error: 'Calendar access was not granted. No connection was made.' }, event);
  }
  const code = queryParam(event, 'code');
  if (!code) {
    return json(400, { error: 'The calendar provider did not return an authorization code.' }, event);
  }

  let tokens;
  let calendars;
  try {
    tokens = await google.exchangeCode(code);
    if (!tokens.refresh_token) {
      // Without a durable credential the sync could never run unattended.
      return json(502, {
        error: 'Your calendar provider did not grant ongoing access. Please try connecting again.',
      }, event);
    }
    calendars = await google.listCalendars(tokens.access_token);
  } catch (err) {
    // Terse, vendor-free, and never the underlying message (it can name the
    // provider); the lib layer already logs nothing sensitive.
    console.error('calendar connect: provider round-trip failed');
    return json(502, {
      error: 'Could not reach your calendar provider. Please try connecting again.',
    }, event);
  }

  // One calendar per connection: the account's primary calendar. Its id is the
  // account email for personal calendars, and its timeZone is authoritative for
  // deriving local session dates later.
  const cal = calendars.find((c) => c.primary) || calendars[0];
  if (!cal || !cal.id) {
    return json(502, {
      error: 'No calendar was found on the connected account.',
    }, event);
  }

  // Upsert on the (user_id, calendar_id) unique key: a re-connect updates the
  // existing row IN PLACE and reuses its id, so the SSM parameter path is stable
  // and gets overwritten — never a second row, never a second parameter.
  // (xmax = 0) distinguishes a fresh insert from a conflict-update, which the
  // SSM-failure cleanup below depends on.
  const upsert = await db.query(
    `insert into calendar_connections
       (practice_id, user_id, provider, account_email, calendar_id, calendar_time_zone, status)
     values ($1, $2, 'google', $3, $4, $5, 'active')
     on conflict (user_id, calendar_id) do update
       set account_email      = excluded.account_email,
           calendar_time_zone = excluded.calendar_time_zone,
           status             = 'active',
           last_sync_error    = null
     returning id, (xmax = 0) as is_new`,
    [st.practice_id, st.sub, cal.id, cal.id, cal.timeZone || null]
  );
  const row = upsert.rows[0];

  try {
    await ssm.putParameter(refreshParamPath(row.id), tokens.refresh_token);
  } catch (err) {
    // Never leave an active row whose SSM parameter does not exist. A fresh
    // insert is rolled back entirely; a conflict-update keeps its row — the
    // parameter at that id's path still holds the previous (still-valid)
    // refresh token, so the invariant stands.
    console.error('calendar connect: credential storage failed');
    if (row.is_new) {
      await db.query('delete from calendar_connections where id = $1', [row.id]);
    }
    return json(502, {
      error: 'Could not securely store the calendar connection. Please try again.',
    }, event);
  }

  await audit(event, authCtx, {
    action: 'calendar_connection.connect',
    resourceType: 'calendar_connection',
    resourceId: row.id,
  });

  return redirect(`${APP_RETURN_URL}?calendar=connected`, event);
}

// GET /integrations/google/status — the caller's own connections. NEVER returns
// tokens, SSM paths, or sync internals beyond what the UI needs.
async function status(event) {
  const { user } = requireAuth(event);
  const result = await db.query(
    `select id, account_email, calendar_id, calendar_time_zone, status, last_synced_at
       from calendar_connections
      where practice_id = $1 and user_id = $2
      order by created_at`,
    [user.practice_id, user.sub]
  );
  return json(200, { connections: result.rows }, event);
}

// POST /integrations/google/disconnect — sets status 'disconnected' and deletes
// the SSM parameter. calendar_events rows are left intact (audit trail).
async function disconnect(event) {
  const { user } = requireAuth(event);
  const body = parseBody(event);
  const connectionId = body.connection_id || body.id;
  if (!connectionId || !UUID_RE.test(String(connectionId).trim())) {
    return json(400, { error: 'connection_id is required.' }, event);
  }

  const result = await db.query(
    `update calendar_connections
        set status = 'disconnected'
      where id = $1 and practice_id = $2 and user_id = $3
      returning id`,
    [String(connectionId).trim(), user.practice_id, user.sub]
  );
  if (result.rowCount === 0) {
    // Cross-practice / cross-user / unknown → 404, never 403.
    return json(404, { error: 'Connection not found.' }, event);
  }
  const id = result.rows[0].id;

  try {
    await ssm.deleteParameter(refreshParamPath(id));
  } catch (err) {
    // The connection is disconnected either way (nothing will read the token
    // again); the orphaned parameter is encrypted at rest and an operator can
    // remove it. Log a terse marker — never the path's contents.
    console.error('calendar disconnect: credential cleanup failed', id);
  }

  await audit(event, { userId: user.sub, practiceId: user.practice_id }, {
    action: 'calendar_connection.disconnect',
    resourceType: 'calendar_connection',
    resourceId: id,
  });

  return json(200, { disconnected: true, id }, event);
}

// --- dispatch --------------------------------------------------------------------

exports.handler = async (event) => {
  const method = httpMethod(event);
  if (method === 'OPTIONS') return preflight(event);

  try {
    const act = action(event);
    if (method === 'GET' && act === 'start') return await start(event);
    if (method === 'GET' && act === 'callback') return await callback(event);
    if (method === 'GET' && act === 'status') return await status(event);
    if (method === 'POST' && act === 'disconnect') return await disconnect(event);
    return json(404, { error: 'Not found.' }, event);
  } catch (err) {
    if (err && err.name === 'AuthError') {
      return json(err.statusCode || 401, { error: err.message }, event);
    }
    // Generic 500 — never the underlying message (it could name the vendor or,
    // from the lib layer, an HTTP status worth keeping server-side only).
    console.error('calendar_oauth error:', (err && err.message) || 'unknown');
    return json(500, { error: 'Something went wrong with the calendar connection.' }, event);
  }
};

// Exposed for unit testing (pure / no network).
exports.makeState = makeState;
exports.verifyState = verifyState;
exports.refreshParamPath = refreshParamPath;
