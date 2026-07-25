'use strict';

// Google OAuth 2.0 + Calendar API client for the INBOUND calendar sync
// (connect flow only — event fetching is a later change). Runs on Node 20+
// (global fetch), no new npm dependencies — same transport conventions as
// backend/lib/clearinghouse/stedi.js: hard AbortController timeout on every
// call, terse errors that never echo the response body.
//
// Scope is calendar.readonly ONLY. access_type=offline + prompt=consent so
// Google actually returns a refresh token on every connect (without
// prompt=consent a re-connect silently omits it).
//
// The OAuth client id/secret live in SSM (SecureStrings) and are read at
// runtime through lib/ssm — they are per-Google-Cloud-project operator
// config, not per-practice data.
//
// Security: NEVER log tokens, authorization codes, or the client secret.
// Error messages carry an HTTP status only, never the response body (token
// endpoint bodies contain live credentials).

const ssm = require('./ssm');

const AUTH_URL =
  process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL =
  process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const CALENDAR_LIST_URL =
  process.env.GOOGLE_CALENDAR_LIST_URL ||
  'https://www.googleapis.com/calendar/v3/users/me/calendarList';

// Read-only calendar access — the narrowest scope that lets the sync read
// events. Never widen without a design review (HIPAA minimum-necessary).
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

// Must byte-match the redirect URI registered on the OAuth client in Google
// Cloud Console AND the one sent on the consent URL, or the code exchange 400s.
const REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ||
  'https://claims.sessionably.com/integrations/google/callback';

// SSM parameter names for the OAuth client credentials.
const CLIENT_ID_PARAM =
  process.env.GOOGLE_CLIENT_ID_SSM_PARAM || '/claimsub/prod/google/client_id';
const CLIENT_SECRET_PARAM =
  process.env.GOOGLE_CLIENT_SECRET_SSM_PARAM || '/claimsub/prod/google/client_secret';

const GOOGLE_TIMEOUT_MS = Number(process.env.GOOGLE_TIMEOUT_MS || 15000);

// The client id is public (it appears in the consent URL) and stable, so cache
// it per warm container. The secret is deliberately NOT cached — it is only
// needed on the rare token calls, and keeping it out of module state shrinks
// its exposure window.
let cachedClientId;

async function getClientId() {
  if (!cachedClientId) {
    cachedClientId = await ssm.getParameter(CLIENT_ID_PARAM);
  }
  return cachedClientId;
}

// Bounded fetch, mirroring stediPost: global fetch has no default timeout, so
// without this a dead network path hangs until the Lambda is killed. The URL is
// never echoed in the timeout error (a query string could carry a code/state).
async function googleFetch(label, url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`Google ${label} request timed out after ${GOOGLE_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// buildAuthUrl({ state }) -> the Google consent URL to redirect the clinician to.
async function buildAuthUrl({ state }) {
  const clientId = await getClientId();
  const qs = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state: String(state == null ? '' : state),
  });
  return `${AUTH_URL}?${qs.toString()}`;
}

// exchangeCode(code) -> { refresh_token, access_token, expires_in }.
// refresh_token is null when Google omitted it (should not happen with
// prompt=consent; the caller must treat that as a failed connect).
async function exchangeCode(code) {
  const [clientId, clientSecret] = await Promise.all([
    getClientId(),
    ssm.getParameter(CLIENT_SECRET_PARAM),
  ]);

  const res = await googleFetch('token exchange', TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: String(code == null ? '' : code),
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }).toString(),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    // Never echo the body — a partial success can still carry live tokens.
    throw new Error(`Google token exchange failed (HTTP ${res.status})`);
  }
  return {
    refresh_token: data.refresh_token || null,
    access_token: data.access_token,
    expires_in: data.expires_in != null ? Number(data.expires_in) : null,
  };
}

// refreshAccessToken(refreshToken) -> short-lived access token string. Access
// tokens are never persisted anywhere — re-minted from the refresh token on
// each use (see calendar_connections' table comment).
async function refreshAccessToken(refreshToken) {
  const [clientId, clientSecret] = await Promise.all([
    getClientId(),
    ssm.getParameter(CLIENT_SECRET_PARAM),
  ]);

  const res = await googleFetch('token refresh', TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: String(refreshToken == null ? '' : refreshToken),
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }).toString(),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    // A 400 invalid_grant here means the clinician revoked access — the caller
    // marks the connection needs_reauth. Status only; never the body.
    throw new Error(`Google token refresh failed (HTTP ${res.status})`);
  }
  return data.access_token;
}

// listCalendars(accessToken) -> array of { id, summary, timeZone, primary }.
// Used at connect time to capture the calendar's own timeZone (authoritative
// for deriving a local session date from an event timestamp — see the
// calendar_connections.calendar_time_zone column comment).
async function listCalendars(accessToken) {
  const res = await googleFetch('calendar list', CALENDAR_LIST_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Google calendar list failed (HTTP ${res.status})`);
  }
  const items = Array.isArray(data && data.items) ? data.items : [];
  return items.map((it) => ({
    id: (it && it.id) || null,
    summary: (it && it.summary) || null,
    timeZone: (it && it.timeZone) || null,
    primary: !!(it && it.primary),
  }));
}

module.exports = {
  buildAuthUrl,
  exchangeCode,
  refreshAccessToken,
  listCalendars,
  SCOPE,
  REDIRECT_URI,
};
