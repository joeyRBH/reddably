/* =============================================================================
 * Reddably — Dashboard (the work homepage)
 * =============================================================================
 * Registers under #dashboard. This is not a metrics wall: it answers "what do I
 * have to do next?" against the one workflow the product is built around —
 *
 *   Sync → Match → Confirm → Verify → Submit → Track
 *
 * Two sections, in deliberate order of weight:
 *
 *   1. What needs attention — at most five action cards, each a real queue with
 *      one destination. A count with no next action is not shown at all, and a
 *      queue at zero is not shown either; all five at zero renders one calm
 *      caught-up state instead of five zeros.
 *   2. Practice overview — subordinate reporting, four compact figures that link
 *      to Reports.
 *
 * The Dashboard only ever INTERPRETS existing state. It creates, updates,
 * confirms, submits and deletes nothing — every card's action navigates to the
 * view that owns that decision.
 *
 * Two load groups that fail independently: a Reports outage must not hide the
 * work queues, and a workflow outage must not hide reporting. A failed request
 * NEVER becomes a zero — zero is only ever a real, successful empty response
 * (a practice with no calendar connected is a true zero, not an error).
 *
 * Counting rules that are easy to get subtly wrong, so they are stated once:
 *
 *   * "Sessions to confirm" is the shared calendar classifier's `awaiting`
 *     bucket (public/app/workflow.js) — the SAME cross-resource, calendar-
 *     sourced definition Calendar uses. A manually created scheduled session
 *     has no calendar event and is never counted.
 *   * "Claims to verify" is every remaining draft, including a draft whose
 *     readiness is unexpectedly absent. It is deliberately NOT called "Ready to
 *     submit": nothing persists a clinician's verification, so the system
 *     cannot tell "not yet reviewed" from "reviewed and ready", and readiness
 *     ready_to_review is a validation projection, not an approval.
 *   * "Claims needing follow-up" is post-submission attention only —
 *     info_requested and denied. Ordinary submitted / processing / paid /
 *     appealed / void claims are not attention work.
 *
 * Built on the shared kit (window.Reddably) and ReddablyAPI — no direct fetch(),
 * no raw hex/px, no new globals, no N+1 per-row detail calls.
 * ========================================================================== */
(function (window, document) {
  'use strict';

  var R = window.Reddably;
  if (!R) return;

  var h = R.h;
  var api = R.api;
  var workflow = R.workflow;
  if (!workflow || !workflow.buildCalendarWorkflow) return;

  // Post-submission statuses that are genuinely waiting on a human. Everything
  // else that has been submitted is either in flight or already resolved.
  var FOLLOW_UP_STATUSES = { info_requested: true, denied: true };

  function greetingName() {
    var cu = R.currentUser;
    var user = (cu && cu.user) || cu;
    if (user && user.first_name) return Promise.resolve(user.first_name);
    // Fall back to a /me call if the shell hasn't cached it yet.
    return api.me().then(function (res) {
      R.currentUser = res;
      return (res && res.user && res.user.first_name) || '';
    }).catch(function () { return ''; });
  }

  // ---------------------------------------------------------------------------
  // Counting (pure — the same inputs always give the same five numbers)
  // ---------------------------------------------------------------------------
  // data: { pending, confirmed, sessions, claims }, nowMs: epoch ms.
  function attentionCounts(data, nowMs) {
    var pending = (data && data.pending) || [];
    var claims = (data && data.claims) || [];

    // Appointments still needing a client: a promoted event carries a
    // session_id, and those are somebody else's queue.
    var toMatch = pending.filter(function (ev) {
      return ev && !ev.session_id;
    }).length;

    var wf = workflow.buildCalendarWorkflow({
      pending: pending,
      confirmed: (data && data.confirmed) || [],
      sessions: (data && data.sessions) || [],
    }, nowMs);

    var drafts = claims.filter(function (c) { return c && c.status === 'draft'; });
    var needsCorrection = drafts.filter(function (c) {
      return c.readiness && c.readiness.state === 'needs_correction';
    }).length;
    // Everything else still in draft is human-review work — including a draft
    // whose readiness the server did not project. Missing readiness is not
    // evidence of correctness, so it stays in front of a person.
    var toVerify = drafts.length - needsCorrection;

    var followUp = claims.filter(function (c) {
      return c && c.status !== 'draft' && FOLLOW_UP_STATUSES[c.status] === true;
    }).length;

    return {
      toMatch: toMatch,
      toConfirm: wf.awaiting.length,
      needsCorrection: needsCorrection,
      toVerify: toVerify,
      followUp: followUp,
    };
  }

  // ---------------------------------------------------------------------------
  // Pieces
  // ---------------------------------------------------------------------------
  function sectionHeading(title, note) {
    return h('div', { class: 'page-header' }, [
      h('h2', { class: 'card__title' }, title),
      note
        ? h('p', {
            style: 'margin:0;color:var(--color-text-muted);font-size:var(--font-size-2)',
          }, note)
        : null,
    ]);
  }

  // One queue: label, count, why it matters, and the single place to go.
  //
  // `qualifier` is the established warning treatment (badge--warning, which is
  // deliberately stone in this design system) and is set only where something is
  // blocked or came back from the payer. Pending workflow carries no badge at
  // all — a badge repeating the count would be decoration, and sage is never
  // used here because none of these are resolved states.
  //
  // The description grows so every card's action sits on the same baseline
  // regardless of how many lines its label wraps to.
  function attentionCard(opts) {
    var action = h('button', {
      class: 'btn btn--primary btn--sm',
      type: 'button',
      onClick: function () { R.navigate(opts.route); },
    }, opts.actionLabel);

    return h('div', { class: 'card stat' }, [
      // The label owns its own row: a badge beside it would squeeze a
      // three-word queue name into a ragged four-line wrap.
      h('span', { class: 'stat__label' }, opts.label),
      h('div', {
        style: 'display:flex;align-items:baseline;gap:var(--space-3);flex-wrap:wrap',
      }, [
        h('span', { class: 'stat__value' }, String(opts.count)),
        opts.qualifier
          ? h('span', { class: 'badge badge--warning' }, opts.qualifier)
          : null,
      ]),
      h('p', {
        style: 'margin:0;flex:1;color:var(--color-text-muted);font-size:var(--font-size-2)',
      }, opts.body),
      h('div', { style: 'margin-top:var(--space-2)' }, action),
    ]);
  }

  function reportCard(label, value) {
    return h('div', { class: 'card stat' }, [
      h('span', { class: 'stat__label' }, label),
      h('span', { class: 'stat__value' }, value),
      h('div', { style: 'margin-top:var(--space-2)' }, h('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        onClick: function () { R.navigate('reports'); },
      }, 'View reports')),
    ]);
  }

  // An inline, retryable failure for ONE section. Never a zero: a request that
  // did not succeed has no count, and saying "0" would be a lie.
  function inlineFailure(message, retry) {
    return h('div', { class: 'card' }, [
      h('p', { class: 'inline-error', style: 'margin:0 0 var(--space-3)' }, message),
      h('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        onClick: retry,
      }, 'Retry'),
    ]);
  }

  function caughtUpCard() {
    return h('div', { class: 'card' }, [
      h('p', { class: 'empty-state__body', style: 'margin:0' },
        'You’re caught up. No appointment matching, session confirmation, ' +
        'or claim-review work is waiting.'),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Sections
  // ---------------------------------------------------------------------------
  function attentionSection(state, retry) {
    var body;
    if (state.error) {
      body = inlineFailure(
        'Could not load your workflow. ' + ((state.error && state.error.message) || ''),
        retry
      );
    } else if (!state.data) {
      body = h('div', { class: 'card' }, h('div', { class: 'skeleton skeleton--line' }));
    } else {
      var n = attentionCounts(state.data, Date.now());
      var cards = [];

      if (n.toMatch) {
        cards.push(attentionCard({
          label: 'Appointments to match',
          count: n.toMatch,
          body: 'Synced appointments that still need a client before a session exists.',
          actionLabel: 'Review Calendar',
          route: 'calendar',
        }));
      }
      if (n.toConfirm) {
        cards.push(attentionCard({
          label: 'Sessions to confirm',
          count: n.toConfirm,
          body: 'Matched appointments that have ended. Confirming creates the draft claim.',
          actionLabel: 'Confirm sessions',
          route: 'calendar',
        }));
      }
      if (n.needsCorrection) {
        cards.push(attentionCard({
          label: 'Claims needing correction',
          count: n.needsCorrection,
          qualifier: 'Blocked',
          body: 'Draft claims with something that would block submission today.',
          actionLabel: 'Correct claims',
          route: 'claims',
        }));
      }
      if (n.toVerify) {
        cards.push(attentionCard({
          label: 'Claims to verify',
          count: n.toVerify,
          body: 'Draft claims a clinician still has to check before they are submitted.',
          actionLabel: 'Verify claims',
          route: 'claims',
        }));
      }
      if (n.followUp) {
        cards.push(attentionCard({
          label: 'Claims needing follow-up',
          count: n.followUp,
          qualifier: 'Payer response',
          body: 'Submitted claims the payer sent back needing information or denied.',
          actionLabel: 'Review claims',
          route: 'claims',
        }));
      }

      body = cards.length
        ? h('div', { class: 'card-grid' }, cards)
        : caughtUpCard();
    }

    return h('div', { class: 'stack' }, [
      sectionHeading('What needs attention', null),
      body,
    ]);
  }

  // Reporting is deliberately subordinate and deliberately literal. The labels
  // say exactly what the numbers are: /reports filters ranges by the claim's
  // created_at, exposes no payment date, and aging.total_billed is the BILLED
  // value of outstanding claims — not reimbursement anyone is owed. Nothing here
  // is recomputed client-side.
  function overviewSection(state, retry) {
    var body;
    if (state.error) {
      body = inlineFailure(
        'Could not load your practice overview. ' + ((state.error && state.error.message) || ''),
        retry
      );
    } else if (!state.data) {
      body = h('div', { class: 'card' }, h('div', { class: 'skeleton skeleton--line' }));
    } else {
      var report = state.data;
      var revenue = report.revenue || {};
      var aging = report.aging || {};
      body = h('div', { class: 'card-grid' }, [
        reportCard('Claims tracked', String(report.claim_count != null ? report.claim_count : 0)),
        reportCard('Total billed', R.fmtMoney(revenue.billed_total)),
        reportCard('Total reimbursed', R.fmtMoney(revenue.reimbursed_total)),
        reportCard('Outstanding billed', R.fmtMoney(aging.total_billed)),
      ]);
    }

    return h('div', { class: 'stack' }, [
      sectionHeading('Practice overview', 'All claims to date. Open Reports to filter.'),
      body,
    ]);
  }

  // ---------------------------------------------------------------------------
  // Mount
  // ---------------------------------------------------------------------------
  function mount(root) {
    // One state object per independently recoverable group. `data` stays null
    // until a load SUCCEEDS, so a failure can never be read as an empty result.
    var state = {
      firstName: '',
      work: { data: null, error: null },
      report: { data: null, error: null },
    };

    function paint() {
      R.clear(root);
      var greeting = state.firstName ? 'Welcome, ' + state.firstName : 'Welcome';
      root.appendChild(h('div', { class: 'view stack' }, [
        h('div', { class: 'page-header' }, [
          h('h1', { class: 'page-header__title' }, greeting),
        ]),
        attentionSection(state.work, loadWork),
        overviewSection(state.report, loadReport),
      ]));
    }

    function loadWork() {
      state.work = { data: null, error: null };
      paint();
      Promise.all([
        // The default list is the review queue: non-cancelled unmatched +
        // matched events.
        api.calendarEvents.list(),
        api.calendarEvents.list({ state: 'confirmed' }),
        api.sessions.list({ status: 'scheduled' }),
        api.claims.list(),
      ]).then(function (res) {
        state.work = {
          data: {
            pending: (res[0] && res[0].calendar_events) || [],
            confirmed: (res[1] && res[1].calendar_events) || [],
            sessions: (res[2] && res[2].sessions) || [],
            claims: (res[3] && res[3].claims) || [],
          },
          error: null,
        };
        paint();
      }).catch(function (err) {
        state.work = { data: null, error: err || new Error('Request failed.') };
        paint();
      });
    }

    function loadReport() {
      state.report = { data: null, error: null };
      paint();
      // No filters: the existing all-time response, used exactly as returned.
      api.reports.summary().then(function (res) {
        state.report = { data: (res && res.report) || {}, error: null };
        paint();
      }).catch(function (err) {
        state.report = { data: null, error: err || new Error('Request failed.') };
        paint();
      });
    }

    R.renderLoading(root);
    greetingName().then(function (name) {
      state.firstName = name || '';
      paint();
      loadWork();
      loadReport();
    });
  }

  R.registerView('dashboard', mount);
})(window, document);
