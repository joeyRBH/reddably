/* =============================================================================
 * Reddably — Calendar (match client → scheduled session → confirm session)
 * =============================================================================
 * Registers under #calendar. The view separates the two decisions that used to
 * share one ambiguous "Confirm" button:
 *
 *   Sync → Match client → Scheduled session → Confirm session → Draft claim
 *
 *   * MATCH CLIENT  — the clinician says which client owns a calendar
 *     appointment. Promotion (POST /calendar-events/{id}/promote) creates the
 *     SCHEDULED session and flips the calendar event to match_state
 *     'confirmed'. The calendar-event row is KEPT — promotion is not a delete,
 *     and this view never issues one.
 *   * CONFIRM SESSION — the clinician says an ENDED, calendar-linked scheduled
 *     session actually happened. That is PATCH /sessions/{id}
 *     { status: 'completed' }, and the server (transactionally, idempotently)
 *     creates the draft claim and advances the session to 'claim_ready'. No
 *     claim is ever created in frontend code.
 *   * SUBMIT CLAIM — a later, explicit action in Claims. Untouched here.
 *
 * The "waiting to be confirmed" section is deliberately CROSS-RESOURCE and
 * CALENDAR-SOURCED ONLY: it is the intersection of confirmed calendar events
 * that carry a session_id and sessions still in 'scheduled'. A manually created
 * session has no calendar event, so it never appears — this view only confirms
 * appointments whose authoritative end time came from the calendar.
 *
 * That bucketing is NOT implemented here: it lives in public/app/workflow.js as
 * window.Reddably.workflow.buildCalendarWorkflow, so the Dashboard's "Sessions
 * to confirm" count reads the very same classifier rather than a second copy.
 *
 * Built entirely on the shared kit (window.Reddably) and ReddablyAPI — no direct
 * fetch(), no raw hex/px, no new globals.
 *
 * White-labeled: the view is "Calendar", the button is "Sync now" — no vendor
 * names anywhere. Match/scheduled badges stay stone (neutral): work in flight is
 * not a resolved state.
 * ========================================================================== */
(function (window, document) {
  'use strict';

  var R = window.Reddably;
  if (!R) return;

  var h = R.h;
  var api = R.api;

  function clientName(c) {
    return c.preferred_name || ((c.first_name || '') + ' ' + (c.last_name || '')).trim();
  }

  // "3:00 PM" from a timestamptz. Falls back to em dash.
  function fmtTime(s) {
    if (!s) return '—';
    var d = new Date(s);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  // The calendar's workflow bucketing lives in public/app/workflow.js
  // (window.Reddably.workflow) — ONE classifier, shared with the Dashboard's
  // "Sessions to confirm" count. The rules (cross-resource awaiting-confirmation
  // intersection, calendar-sourced sessions only, authoritative linked-event
  // ends_at, all-day and cancelled handling, split past/upcoming ordering) are
  // unchanged; they simply no longer live in this file.
  var buildWorkflow = R.workflow && R.workflow.buildCalendarWorkflow;
  if (!buildWorkflow) return;

  function inlineEmpty(text) {
    return h('p', {
      class: 'empty-state__body',
      style: 'margin:0;padding:var(--space-3) 0',
    }, text);
  }

  function sectionCard(title, note, body) {
    return h('div', { class: 'card' }, [
      h('div', { class: 'card__header' }, [
        h('h2', { class: 'card__title' }, title),
        note
          ? h('p', {
              style: 'margin:0;color:var(--color-text-muted);font-size:var(--font-size-2)',
            }, note)
          : null,
      ]),
      body,
    ]);
  }

  function renderCalendar(root) {
    R.renderLoading(root);

    function load() {
      R.renderLoading(root);
      Promise.all([
        // Default list = the review queue (unmatched + matched).
        api.calendarEvents.list(),
        api.calendarEvents.list({ state: 'confirmed' }),
        api.calendarEvents.list({ state: 'ignored' }),
        api.sessions.list({ status: 'scheduled' }),
        api.clients.list(),
        // No active connection (404) or a provider hiccup must not take the
        // review list down — the picker just doesn't render.
        api.calendarConnections.calendars().catch(function () { return null; }),
      ]).then(function (results) {
        function eventsOf(res) { return (res && res.calendar_events) || []; }
        // Pickable clients: not soft-deleted (the API already excludes those)
        // and not inactive — mirrors the matcher's candidate set.
        var clients = ((results[4] && results[4].clients) || []).filter(function (c) {
          return c.status !== 'inactive';
        });
        render({
          pending: eventsOf(results[0]),
          confirmed: eventsOf(results[1]),
          ignored: eventsOf(results[2]),
          sessions: (results[3] && results[3].sessions) || [],
        }, clients, results[5]);
      }).catch(function (err) {
        R.renderError(root, err, load);
      });
    }

    function render(data, clients, calInfo) {
      R.clear(root);

      var workflow = buildWorkflow(data, Date.now());

      // Display labels for the picker; duplicate names are disambiguated with
      // the date of birth so a choice is never silently the wrong person.
      var nameCounts = {};
      clients.forEach(function (c) {
        var n = clientName(c);
        nameCounts[n] = (nameCounts[n] || 0) + 1;
      });
      var labelToId = {};
      var pickerOptions = clients.map(function (c) {
        var label = clientName(c);
        if (nameCounts[label] > 1) {
          label += c.date_of_birth
            ? ' (DOB ' + R.fmtDate(c.date_of_birth) + ')'
            : ' (' + String(c.id).slice(0, 8) + ')';
        }
        labelToId[label] = c.id;
        return label;
      });

      // --- actions -----------------------------------------------------------
      // Every action reloads on success: promotion KEEPS the calendar-event row
      // and moves it between sections, so the view has to re-derive the buckets
      // rather than splice a row out of the DOM.

      function matchClient(ev, clientId, buttons) {
        buttons.forEach(function (b) { b.disabled = true; });
        api.calendarEvents.promote(ev.id, clientId).then(function (res) {
          var session = res && res.session;
          // Surface the session date so a timezone error is visible immediately.
          var when = session && session.session_date ? R.fmtDate(session.session_date) : null;
          R.toast(when
            ? 'Client matched — session scheduled for ' + when
            : 'Client matched — session scheduled', 'success');
          load();
        }).catch(function (err) {
          buttons.forEach(function (b) { b.disabled = false; });
          R.toast((err && err.message) || 'Could not match this appointment.', 'error');
        });
      }

      // The ended, calendar-linked session actually happened. The server creates
      // the draft claim inside its own transaction — never this view.
      function confirmSession(row, buttons) {
        buttons.forEach(function (b) { b.disabled = true; });
        api.sessions.update(row.session.id, { status: 'completed' }).then(function (res) {
          R.toast(res && res.claim_created === true
            ? 'Session confirmed — claim draft ready in Claims.'
            : 'Session confirmed.', 'success');
          load();
        }).catch(function (err) {
          buttons.forEach(function (b) { b.disabled = false; });
          R.toast((err && err.message) || 'Could not confirm this session.', 'error');
        });
      }

      function ignore(ev, buttons) {
        buttons.forEach(function (b) { b.disabled = true; });
        api.calendarEvents.ignore(ev.id).then(function () {
          R.toast('Appointment ignored', 'success');
          load();
        }).catch(function (err) {
          buttons.forEach(function (b) { b.disabled = false; });
          R.toast((err && err.message) || 'Could not ignore this appointment.', 'error');
        });
      }

      // --- row builders ------------------------------------------------------

      function contextCells(ev) {
        return [
          h('td', null, R.fmtDate(ev.starts_at)),
          h('td', null, fmtTime(ev.starts_at)),
          h('td', null, ev.duration_minutes != null ? ev.duration_minutes + ' min' : '—'),
          h('td', null, ev.summary_raw || '—'),
        ];
      }

      // A matched-client cell with the suggestion badge (stone: a suggestion is
      // in-flight work, not a resolved state).
      function suggestionCell(ev) {
        var confidence = ev.match_confidence != null
          ? Math.round(Number(ev.match_confidence)) + '%'
          : null;
        return h('td', null, [
          h('span', null, ev.matched_client_name || '—'),
          confidence
            ? h('span', {
                class: 'badge badge--neutral',
                style: 'margin-left:var(--space-2)',
              }, confidence + ' match')
            : null,
        ]);
      }

      // The searchable client picker (native datalist type-ahead). "Match client"
      // enables only on an exact pick, so a half-typed name can never promote.
      function pickerCell(ev, buttons) {
        var listId = 'calendar-client-options-' + ev.id;
        var matchBtn = h('button', {
          class: 'btn btn--primary btn--sm', type: 'button', disabled: 'disabled',
        }, 'Match client');
        var input = h('input', {
          class: 'field__control',
          type: 'text',
          list: listId,
          placeholder: clients.length ? 'Search clients…' : 'No active clients',
          'aria-label': 'Choose a client for this appointment',
          style: 'max-width:16rem;font-size:var(--font-size-2)',
          onInput: function (e) {
            matchBtn.disabled = !labelToId[e.target.value];
          },
        });
        if (!clients.length) input.disabled = true;
        matchBtn.addEventListener('click', function () {
          var clientId = labelToId[input.value];
          if (clientId) matchClient(ev, clientId, buttons);
        });
        return {
          cell: h('td', null, [
            input,
            h('datalist', { id: listId },
              pickerOptions.map(function (label) { return h('option', { value: label }); })),
          ]),
          button: matchBtn,
        };
      }

      // One row of a matching section. mode 'suggested' offers the matched client
      // with Match client / Change; 'picker' offers the searchable input. Change
      // repaints the same row in picker mode.
      function paintMatchRow(ev, row, mode, showIgnore) {
        R.clear(row);
        var buttons = [];
        var actionEls = [];
        var clientCell;

        if (mode === 'suggested' && ev.matched_client_id) {
          clientCell = suggestionCell(ev);
          var matchBtn = h('button', {
            class: 'btn btn--primary btn--sm', type: 'button',
            onClick: function () { matchClient(ev, ev.matched_client_id, buttons); },
          }, 'Match client');
          var changeBtn = h('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            style: 'margin-left:var(--space-2)',
            onClick: function () { paintMatchRow(ev, row, 'picker', showIgnore); },
          }, 'Change');
          buttons.push(matchBtn, changeBtn);
          actionEls.push(matchBtn, changeBtn);
        } else {
          var picked = pickerCell(ev, buttons);
          clientCell = picked.cell;
          buttons.push(picked.button);
          actionEls.push(picked.button);
        }

        if (showIgnore) {
          var ignoreBtn = h('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            style: 'margin-left:var(--space-2)',
            onClick: function () { ignore(ev, buttons); },
          }, 'Ignore');
          buttons.push(ignoreBtn);
          actionEls.push(ignoreBtn);
        }

        contextCells(ev).concat([
          clientCell,
          h('td', { class: 'data-table__num' }, actionEls),
        ]).forEach(function (cell) { row.appendChild(cell); });
      }

      // An already-promoted upcoming appointment: scheduled state only. No
      // Confirm session before the appointment ends, and no second session.
      function paintScheduledRow(ev, row) {
        R.clear(row);
        contextCells(ev).concat([
          h('td', null, ev.matched_client_name || '—'),
          h('td', { class: 'data-table__num' },
            h('span', { class: 'badge badge--neutral' }, 'Scheduled')),
        ]).forEach(function (cell) { row.appendChild(cell); });
      }

      // The one dominant action of the whole view.
      function paintConfirmRow(item, row) {
        R.clear(row);
        var buttons = [];
        var confirmBtn = h('button', {
          class: 'btn btn--primary btn--sm', type: 'button',
          onClick: function () { confirmSession(item, buttons); },
        }, 'Confirm session');
        buttons.push(confirmBtn);
        contextCells(item.event).concat([
          h('td', null, item.event.matched_client_name || '—'),
          h('td', { class: 'data-table__num' }, confirmBtn),
        ]).forEach(function (cell) { row.appendChild(cell); });
      }

      // --- sections ----------------------------------------------------------

      function sectionTable(clientHeading, rows, emptyText) {
        var tbody = h('tbody');
        if (!rows.length) {
          tbody.appendChild(h('tr', null,
            h('td', { colspan: '6' }, inlineEmpty(emptyText))));
        } else {
          rows.forEach(function (paint) {
            var row = h('tr');
            paint(row);
            tbody.appendChild(row);
          });
        }
        return h('table', { class: 'data-table' }, [
          h('thead', null, h('tr', null, [
            h('th', null, 'Date'),
            h('th', null, 'Time'),
            h('th', null, 'Duration'),
            h('th', null, 'Appointment'),
            h('th', null, clientHeading),
            h('th', { class: 'data-table__num' }, ''),
          ])),
          tbody,
        ]);
      }

      var awaitingCard = sectionCard(
        'Sessions to confirm',
        'Appointments that have ended. Confirming creates the draft claim.',
        sectionTable('Client', workflow.awaiting.map(function (item) {
          return function (row) { paintConfirmRow(item, row); };
        }), 'No sessions waiting to be confirmed.')
      );

      var matchingCard = sectionCard(
        'Appointments needing a client',
        'Past appointments that were never matched. Matching schedules the session.',
        sectionTable('Client', workflow.matching.map(function (item) {
          var ev = item.event;
          return function (row) {
            paintMatchRow(ev, row,
              ev.match_state === 'matched' && ev.matched_client_id ? 'suggested' : 'picker',
              true);
          };
        }), 'No past appointments waiting for a client.')
      );

      var upcomingCard = sectionCard(
        'Upcoming appointments',
        'Match a client ahead of time. Confirming waits until the appointment ends.',
        sectionTable('Client', workflow.upcoming.map(function (item) {
          var ev = item.event;
          return function (row) {
            if (ev.session_id) {
              paintScheduledRow(ev, row);
              return;
            }
            paintMatchRow(ev, row,
              ev.match_state === 'matched' && ev.matched_client_id ? 'suggested' : 'picker',
              true);
          };
        }), 'No upcoming appointments. Sync to pull in new appointments.')
      );

      // Subordinate: set aside, but reversible — matching one still promotes it.
      var ignoredCard = sectionCard(
        'Ignored appointments',
        'Set aside. Matching a client still schedules the session.',
        sectionTable('Client', workflow.ignored.map(function (item) {
          var ev = item.event;
          return function (row) {
            paintMatchRow(ev, row,
              ev.match_state === 'matched' && ev.matched_client_id ? 'suggested' : 'picker',
              false);
          };
        }), 'No ignored appointments.')
      );

      // --- shell -------------------------------------------------------------

      var syncBtn = h('button', {
        class: 'btn btn--primary', type: 'button',
        onClick: function () {
          syncBtn.disabled = true;
          api.calendarEvents.sync().then(function () {
            R.toast('Calendar synced', 'success');
            load();
          }).catch(function (err) {
            syncBtn.disabled = false;
            R.toast((err && err.message) || 'Could not sync your calendar.', 'error');
          });
        },
      }, 'Sync now');

      // Which of the account's calendars this connection syncs. Switching
      // clears staged (unconfirmed) appointments server-side, so it always
      // warns first; confirmed rows are untouched.
      var calendarPicker = null;
      if (calInfo && calInfo.connection_id && (calInfo.calendars || []).length) {
        var current = null;
        var picker = h('select', {
          class: 'field__control',
          'aria-label': 'Calendar to sync',
          style: 'max-width:16rem;font-size:var(--font-size-2)',
        }, calInfo.calendars.map(function (cal) {
          if (cal.is_current) current = cal;
          var opt = h('option', { value: cal.id }, cal.name);
          if (cal.is_current) opt.selected = true;
          return opt;
        }));
        picker.addEventListener('change', function () {
          var chosen = null;
          calInfo.calendars.forEach(function (cal) {
            if (cal.id === picker.value) chosen = cal;
          });
          if (!chosen || (current && chosen.id === current.id)) return;
          var ok = window.confirm(
            'Switch syncing to "' + chosen.name + '"?\n\n' +
            'Staged appointments not yet matched to a client will be cleared. ' +
            'Scheduled sessions are kept.'
          );
          if (!ok) {
            picker.value = current ? current.id : '';
            return;
          }
          picker.disabled = true;
          syncBtn.disabled = true;
          api.calendarConnections.setCalendar(calInfo.connection_id, chosen.id)
            .then(function () {
              R.toast('Now syncing "' + chosen.name + '"', 'success');
              // Pull the new calendar's appointments in right away, then
              // reload the list either way — the switch itself succeeded.
              return api.calendarEvents.sync().catch(function () {});
            })
            .then(load)
            .catch(function (err) {
              picker.disabled = false;
              syncBtn.disabled = false;
              picker.value = current ? current.id : '';
              R.toast((err && err.message) || 'Could not switch calendars.', 'error');
            });
        });
        calendarPicker = h('label', {
          style: 'display:inline-flex;align-items:center;gap:var(--space-2);' +
            'color:var(--color-text-muted);font-size:var(--font-size-2)',
        }, ['Syncing', picker]);
      }

      root.appendChild(h('div', { class: 'view stack' }, [
        h('div', { class: 'page-header' }, [
          h('h1', { class: 'page-header__title' }, 'Calendar'),
          h('div', { class: 'page-header__actions' }, [calendarPicker, syncBtn]),
        ]),
        h('p', {
          style: 'margin:0;color:var(--color-text-muted);font-size:var(--font-size-3)',
        }, 'Match each appointment to a client, then confirm the session once it has ended.'),
        awaitingCard,
        matchingCard,
        upcomingCard,
        ignoredCard,
      ]));
    }

    load();
  }

  R.registerView('calendar', function (root) {
    return renderCalendar(root);
  });
})(window, document);
