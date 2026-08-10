/* =============================================================================
 * Reddably — shared calendar workflow classifier (window.Reddably.workflow)
 * =============================================================================
 * ONE implementation of the calendar bucketing, shared by every surface that
 * has to reason about where an appointment sits in
 *
 *   Sync → Match → Confirm → Verify → Submit → Track
 *
 * It was extracted verbatim from public/app/views/calendar.js (PR #94) so the
 * Calendar view and the Dashboard's "Sessions to confirm" count can never drift
 * apart: a second copy of these rules would be a second, silently divergent
 * definition of which sessions a clinician still has to confirm.
 *
 * Pure: no DOM, no network, no globals beyond attaching itself to the existing
 * Reddably namespace. Loaded after views.js (which creates window.Reddably) and
 * before any view registers.
 * ========================================================================== */
(function (window) {
  'use strict';

  var R = window.Reddably;
  if (!R) return;

  // Epoch ms for a timestamp, or null when it is absent or unparseable. A null
  // here is load-bearing: without an authoritative end time an appointment can
  // never become confirmable.
  function msOf(value) {
    if (!value) return null;
    var t = new Date(value).getTime();
    return isNaN(t) ? null : t;
  }

  // Sort the calendar's four work buckets out of the four things we load.
  //
  //   data.pending   — events in match_state unmatched|matched (the review queue)
  //   data.confirmed — events already promoted (match_state 'confirmed')
  //   data.ignored   — events set aside
  //   data.sessions  — sessions with status 'scheduled'
  //
  // Rules that matter:
  //   * awaiting  = confirmed event WITH session_id  ∩  still-'scheduled' session
  //     of that id, whose effective end is already past. session_date is never
  //     used to decide it.
  //   * upcoming  = non-ignored, non-cancelled events whose end is still ahead.
  //   * matching  = unpromoted events that have ended (or that carry no end time
  //     at all — all-day appointments sync with ends_at null, and they must stay
  //     visible as work rather than silently vanish; they are placed by their
  //     start so a FUTURE all-day appointment still reads as upcoming).
  //   * Ordering is intentionally split: past work newest-first (ends_at DESC),
  //     upcoming soonest-first (starts_at ASC).
  //
  // "Effective end" is ends_at when usable and starts_at otherwise, applied
  // identically in BOTH loops. That symmetry is the whole point: an all-day
  // appointment (ends_at null) is placed by its start whether or not it has been
  // promoted, so it stays in exactly one bucket through the pipeline
  //
  //   needs a client -> (match) -> awaiting confirmation -> (confirm) -> gone
  //
  // rather than leaving `matching` on promotion and landing in no bucket at all.
  // The consequence for an all-day appointment is that it becomes confirmable at
  // the start of its own day; confirming is a deliberate human action, so an
  // early offer costs nothing, while the previous silent disappearance stranded
  // the session in 'scheduled' forever.
  //
  // Callers that only need `awaiting` (the Dashboard) may omit data.ignored —
  // an absent bucket is an empty one, never an error.
  function buildCalendarWorkflow(data, nowMs) {
    var pending = (data && data.pending) || [];
    var confirmed = (data && data.confirmed) || [];
    var ignoredEvents = (data && data.ignored) || [];
    var sessions = (data && data.sessions) || [];
    var awaiting = [];
    var matching = [];
    var upcoming = [];
    var ignored = [];
    var scheduledById = {};
    sessions.forEach(function (s) {
      if (s && s.id && s.status === 'scheduled') scheduledById[s.id] = s;
    });
    function item(ev, session) {
      return { event: ev, session: session || null, startMs: msOf(ev.starts_at), endMs: msOf(ev.ends_at) };
    }
    function live(ev) {
      return !!ev && ev.event_status !== 'cancelled';
    }
    // Already promoted: either still ahead (scheduled, nothing to do yet) or
    // ended and waiting on the clinician's confirmation.
    confirmed.filter(live).forEach(function (ev) {
      var row = item(ev, null);
      // The same end-time fallback the pending loop applies below.
      var effectiveEnd = row.endMs === null ? row.startMs : row.endMs;
      if (effectiveEnd === null) return;
      if (effectiveEnd > nowMs) {
        upcoming.push(row);
        return;
      }
      var session = ev.session_id ? scheduledById[ev.session_id] : null;
      if (!session) return;
      row.session = session;
      awaiting.push(row);
    });
    // Not promoted yet: still needs a client.
    pending.filter(live).forEach(function (ev) {
      if (ev.session_id) return;
      var row = item(ev, null);
      var ahead = row.endMs === null ? row.startMs !== null && row.startMs > nowMs : row.endMs > nowMs;
      if (ahead) upcoming.push(row);
      else matching.push(row);
    });
    ignoredEvents.filter(live).forEach(function (ev) {
      ignored.push(item(ev, null));
    });
    function byEndDesc(a, b) {
      var x = a.endMs === null ? -Infinity : a.endMs;
      var y = b.endMs === null ? -Infinity : b.endMs;
      if (x !== y) return y - x;
      return (b.startMs || 0) - (a.startMs || 0);
    }
    function byStartAsc(a, b) {
      var x = a.startMs === null ? Infinity : a.startMs;
      var y = b.startMs === null ? Infinity : b.startMs;
      return x - y;
    }
    awaiting.sort(byEndDesc);
    matching.sort(byEndDesc);
    ignored.sort(byEndDesc);
    upcoming.sort(byStartAsc);
    return { awaiting: awaiting, matching: matching, upcoming: upcoming, ignored: ignored };
  }

  R.workflow = {
    buildCalendarWorkflow: buildCalendarWorkflow,
  };
})(window);
