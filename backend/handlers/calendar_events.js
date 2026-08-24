'use strict';

// Staged calendar events — review + promotion to sessions. Routes live under
// /calendar-events/* (NOT /calendar/*, which is the outbound ICS feed):
//
//   GET  /calendar-events               → list staged events for review
//   POST /calendar-events/{id}/promote  → create the sessions row (human confirm)
//   POST /calendar-events/{id}/ignore   → set match_state 'ignored' (no session)
//
// Promotion is THE money-relevant step: a sessions row is what becomes a claim
// and what triggers the 5% platform fee, so it only ever happens here, on an
// explicit request naming a client_id — never from a name match. It is
// idempotent (an already-promoted event returns its existing session), rejects
// cancelled events, and runs the session INSERT + event UPDATE in one
// transaction so a failure leaves the event unconfirmed.
//
// session_date is the event's starts_at converted to a calendar date in the
// CONNECTION's calendar_time_zone — never UTC. A 6pm Denver appointment must
// not land on the next day.
//
// Security: practice_id always derives from the authenticated user's row, never
// the request. Every query is practice-scoped. summary_raw and client names are
// PHI — they are returned to the caller's own practice only and NEVER logged.

const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');
const { parseBody } = require('../lib/util');
const { audit } = require('../lib/audit');
const { applyClientDefaults } = require('../lib/billing_fields');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// States a caller may filter the list by. Default (no param) is the review
// queue: unmatched + matched only.
const LISTABLE_STATES = ['unmatched', 'matched', 'confirmed', 'ignored'];

// --- request helpers ---------------------------------------------------------

function httpMethod(event) {
  if (!event) return '';
  if (event.httpMethod) return event.httpMethod;
  const ctx = event.requestContext;
  return (ctx && ctx.http && ctx.http.method) || '';
}

function pathId(event) {
  return event && event.pathParameters ? event.pathParameters.id : undefined;
}

function queryParam(event, name) {
  return event && event.queryStringParameters ? event.queryStringParameters[name] : undefined;
}

// Trailing action segment for /calendar-events/{id}/<action> routes, or null.
// Reads the v2 routeKey template first (stable), falling back to the raw path.
function subAction(event) {
  const rk = (event && event.requestContext && event.requestContext.routeKey) || '';
  let m = rk.match(/\/calendar-events\/\{id\}\/([a-z]+)$/i);
  if (m) return m[1].toLowerCase();
  const path =
    (event && event.requestContext && event.requestContext.http && event.requestContext.http.path) ||
    (event && event.rawPath) || '';
  m = path.match(/\/calendar-events\/[^/]+\/([a-z]+)\/?$/i);
  return m ? m[1].toLowerCase() : null;
}

function isUUID(v) {
  return typeof v === 'string' && UUID_RE.test(v.trim());
}

// --- time --------------------------------------------------------------------

// starts_at → 'YYYY-MM-DD' in the connection's calendar_time_zone. en-CA
// formats as ISO. Missing/invalid zone falls back to UTC (matching ingestion's
// fallback for all-day events).
function sessionDateInZone(startsAt, timeZone) {
  const d = startsAt instanceof Date ? startsAt : new Date(startsAt);
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d);
    } catch (_) {
      // Unknown zone — fall through to UTC.
    }
  }
  return d.toISOString().slice(0, 10);
}

// --- shaping -----------------------------------------------------------------

// A staged event for the review UI. Belongs to the caller's own practice, so
// summary_raw and the matched client's display name are safe to RETURN (they
// are still never logged).
function shapeEvent(r) {
  if (!r) return null;
  return {
    id: r.id,
    summary_raw: r.summary_raw,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    duration_minutes: r.duration_minutes,
    event_status: r.event_status,
    match_state: r.match_state,
    matched_client_id: r.matched_client_id,
    match_confidence: r.match_confidence,
    match_reason: r.match_reason,
    session_id: r.session_id,
    matched_client_name: r.matched_client_name || null,
  };
}

function shapeSession(r) {
  if (!r) return null;
  return {
    id: r.id,
    practice_id: r.practice_id,
    client_id: r.client_id,
    clinician_id: r.clinician_id,
    session_date: r.session_date,
    duration_minutes: r.duration_minutes,
    cpt_code: r.cpt_code,
    diagnosis_codes: r.diagnosis_codes,
    place_of_service: r.place_of_service,
    procedure_modifiers: r.procedure_modifiers,
    fee: r.fee,
    status: r.status,
    source: r.source,
    created_at: r.created_at,
  };
}

// --- practice scoping --------------------------------------------------------

// Caller's practice_id from their (active) users row — a deactivated user can't
// keep acting on a still-valid token.
async function loadPracticeId(userId) {
  const res = await db.query(
    `select practice_id from users where id = $1 and is_active = true limit 1`,
    [userId]
  );
  return res.rows[0] ? res.rows[0].practice_id : null;
}

// --- GET /calendar-events ----------------------------------------------------

async function listEvents(practiceId, event, authCtx) {
  const conditions = ['e.practice_id = $1', `e.event_status <> 'cancelled'`];
  const params = [practiceId];

  const state = queryParam(event, 'state');
  if (state != null && state !== '') {
    if (!LISTABLE_STATES.includes(state)) {
      return json(400, { error: `Invalid state. Expected one of: ${LISTABLE_STATES.join(', ')}` }, event);
    }
    params.push(state);
    conditions.push(`e.match_state = $${params.length}`);
  } else {
    conditions.push(`e.match_state in ('unmatched', 'matched')`);
  }

  for (const [name, op] of [['from', '>='], ['to', '<=']]) {
    const v = queryParam(event, name);
    if (v != null && v !== '') {
      if (!ISO_DATE.test(v)) {
        return json(400, { error: `Invalid ${name}. Expected YYYY-MM-DD.` }, event);
      }
      params.push(v);
      conditions.push(`e.starts_at::date ${op} $${params.length}`);
    }
  }

  const res = await db.query(
    `select e.id, e.summary_raw, e.starts_at, e.ends_at, e.duration_minutes,
            e.event_status, e.match_state, e.matched_client_id, e.match_confidence,
            e.match_reason, e.session_id,
            case when c.id is null then null
                 else coalesce(nullif(trim(c.preferred_name), ''),
                               trim(c.first_name || ' ' || c.last_name))
            end as matched_client_name
       from calendar_events e
       left join clients c on c.id = e.matched_client_id and c.is_hidden = false
      where ${conditions.join(' and ')}
      order by e.starts_at desc`,
    params
  );

  await audit(event, authCtx, {
    action: 'calendar_event.list',
    resourceType: 'calendar_event',
    metadata: { count: res.rowCount },
  });
  return json(200, { calendar_events: res.rows.map(shapeEvent) }, event);
}

// --- POST /calendar-events/{id}/promote --------------------------------------

async function promoteEvent(practiceId, id, body, event, authCtx) {
  if (!isUUID(id)) return json(404, { error: 'Not found' }, event);

  const clientId = body && typeof body.client_id === 'string' ? body.client_id.trim() : '';
  if (!isUUID(clientId)) {
    return json(400, { error: 'client_id is required.' }, event);
  }

  const result = await db.withTransaction(async (tx) => {
    // Lock the event row for the duration of the transaction so two concurrent
    // promotes can't both pass the session_id-null check and insert twice.
    const evRes = await tx.query(
      `select e.*, cc.calendar_time_zone
         from calendar_events e
         join calendar_connections cc on cc.id = e.connection_id
        where e.id = $1 and e.practice_id = $2
          for update of e`,
      [id, practiceId]
    );
    const ev = evRes.rows[0];
    if (!ev) return { status: 404, body: { error: 'Not found' } };

    if (ev.event_status === 'cancelled') {
      return { status: 400, body: { error: 'This appointment was cancelled and cannot become a session.' } };
    }

    // Idempotent: already promoted → return the existing session unchanged.
    if (ev.session_id) {
      const existing = await tx.query(
        `select * from sessions where id = $1 and practice_id = $2 limit 1`,
        [ev.session_id, practiceId]
      );
      return {
        status: 200,
        body: {
          session: shapeSession(existing.rows[0]),
          calendar_event: shapeEvent(ev),
          already_promoted: true,
        },
      };
    }

    // The client must belong to the caller's practice. Their billing DEFAULTS
    // carry onto the session (per-session override stays possible later), so the
    // whole row is selected rather than a projection.
    const cliRes = await tx.query(
      `select * from clients
        where id = $1 and practice_id = $2 and is_hidden = false
        limit 1`,
      [clientId, practiceId]
    );
    const client = cliRes.rows[0];
    if (!client) {
      return { status: 400, body: { error: 'client_id is not a client in this practice.' } };
    }

    // A calendar event still carries appointment facts, not billing data — but
    // the CLIENT carries billing defaults, and those seed the session here. This
    // is what makes "the clinician just verifies the appointment" true: the
    // promoted session arrives with a CPT code, place of service, fee, modifiers
    // and diagnosis already on it, instead of four NULLs that had to be typed in
    // by hand before the session could become a submittable claim.
    //
    // A client with no defaults set behaves exactly as before (all NULL) — the
    // seeding only ever fills a blank, never overwrites.
    //
    // The event itself is still never trusted to supply billing data, and a name
    // match still never promotes anything on its own: this runs only after an
    // explicit human confirmation upstream.
    const billing = applyClientDefaults({}, client);
    const sessionDate = sessionDateInZone(ev.starts_at, ev.calendar_time_zone);
    const insRes = await tx.query(
      `insert into sessions
         (practice_id, client_id, clinician_id, session_date, duration_minutes,
          diagnosis_codes, cpt_code, place_of_service, procedure_modifiers, fee,
          status, source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'scheduled', 'calendar')
       returning *`,
      [
        ev.practice_id,
        client.id,
        ev.clinician_id,
        sessionDate,
        ev.duration_minutes,
        billing.diagnosis_codes || null,
        billing.cpt_code || null,
        billing.place_of_service || null,
        billing.procedure_modifiers || null,
        billing.fee != null ? billing.fee : null,
      ]
    );
    const session = insRes.rows[0];

    const updRes = await tx.query(
      `update calendar_events
          set match_state = 'confirmed',
              matched_client_id = $2,
              session_id = $3,
              promoted_at = now()
        where id = $1
        returning *`,
      [ev.id, client.id, session.id]
    );

    return {
      status: 201,
      body: {
        session: shapeSession(session),
        calendar_event: shapeEvent(updRes.rows[0]),
      },
    };
  });

  if (result.status === 201) {
    await audit(event, authCtx, {
      action: 'calendar_event.promote',
      resourceType: 'calendar_event',
      resourceId: id,
      metadata: { session_id: result.body.session.id },
    });
  }
  return json(result.status, result.body, event);
}

// --- POST /calendar-events/{id}/ignore ---------------------------------------

async function ignoreEvent(practiceId, id, event, authCtx) {
  if (!isUUID(id)) return json(404, { error: 'Not found' }, event);

  // A confirmed event already has a session — ignoring it would orphan the
  // linkage, so it is refused. Everything else (unmatched/matched/ignored) may
  // move to 'ignored'; promote remains available to reverse it.
  const res = await db.query(
    `update calendar_events
        set match_state = 'ignored'
      where id = $1 and practice_id = $2 and match_state <> 'confirmed'
      returning id, match_state`,
    [id, practiceId]
  );
  if (res.rowCount === 0) {
    const exists = await db.query(
      `select 1 from calendar_events where id = $1 and practice_id = $2 limit 1`,
      [id, practiceId]
    );
    if (exists.rowCount === 0) return json(404, { error: 'Not found' }, event);
    return json(400, { error: 'This appointment was already confirmed as a session.' }, event);
  }

  await audit(event, authCtx, {
    action: 'calendar_event.ignore',
    resourceType: 'calendar_event',
    resourceId: id,
  });
  return json(200, { ignored: true, id: res.rows[0].id }, event);
}

// --- entrypoint --------------------------------------------------------------

exports.handler = async (event) => {
  const method = httpMethod(event);
  if (method === 'OPTIONS') return preflight(event);

  let auth;
  try {
    auth = requireAuth(event);
  } catch (err) {
    return json(err.statusCode || 401, { error: 'Unauthorized' }, event);
  }

  try {
    const practiceId = await loadPracticeId(auth.user.sub);
    if (!practiceId) {
      return json(401, { error: 'Unauthorized' }, event);
    }

    const id = pathId(event);
    const action = subAction(event);
    const authCtx = { userId: auth.user.sub, practiceId };

    if (method === 'GET' && !id) {
      return await listEvents(practiceId, event, authCtx);
    }
    if (method === 'POST' && id && action === 'promote') {
      return await promoteEvent(practiceId, id, parseBody(event), event, authCtx);
    }
    if (method === 'POST' && id && action === 'ignore') {
      return await ignoreEvent(practiceId, id, event, authCtx);
    }

    return json(405, { error: 'Method not allowed' }, event);
  } catch (err) {
    // Never log PHI (event titles, client names) — only a generic message.
    console.error('calendar_events error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
