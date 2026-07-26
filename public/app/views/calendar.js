/* =============================================================================
 * Reddably — Calendar review (staged appointments → sessions)
 * =============================================================================
 * Registers under #calendar. A single newest-first list of staged calendar
 * appointments (unmatched + matched): confirm a suggested client, pick one by
 * hand, or ignore the row. Confirming creates the session (server-side) and the
 * row leaves the list. Built entirely on the shared kit (window.Reddably) and
 * ReddablyAPI — no direct fetch(), no raw hex/px, no new globals.
 *
 * White-labeled: the view is "Calendar", the button is "Sync now" — no vendor
 * names anywhere. Suggestion badges stay stone (neutral): a match is in-flight
 * work, not a resolved state.
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

  function inlineEmpty(text) {
    return h('p', {
      class: 'empty-state__body',
      style: 'margin:0;padding:var(--space-3) 0',
    }, text);
  }

  function renderCalendar(root) {
    R.renderLoading(root);

    function load() {
      R.renderLoading(root);
      Promise.all([
        api.calendarEvents.list(),
        api.clients.list(),
        // No active connection (404) or a provider hiccup must not take the
        // review list down — the picker just doesn't render.
        api.calendarConnections.calendars().catch(function () { return null; }),
      ]).then(function (results) {
        var events = (results[0] && results[0].calendar_events) || [];
        // Pickable clients: not soft-deleted (the API already excludes those)
        // and not inactive — mirrors the matcher's candidate set.
        var clients = ((results[1] && results[1].clients) || []).filter(function (c) {
          return c.status !== 'inactive';
        });
        render(events, clients, results[2]);
      }).catch(function (err) {
        R.renderError(root, err, load);
      });
    }

    function render(events, clients, calInfo) {
      R.clear(root);

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

      var pending = events.slice();
      var countEl = h('p', {
        style: 'margin:0;color:var(--color-text-muted);font-size:var(--font-size-3)',
      });
      var tbody = h('tbody');

      function updateCount() {
        countEl.textContent = pending.length === 0
          ? 'No appointments waiting for review.'
          : pending.length + (pending.length === 1
            ? ' appointment waiting for review.'
            : ' appointments waiting for review.');
      }

      function removeRow(ev, rowEls) {
        pending = pending.filter(function (e) { return e.id !== ev.id; });
        rowEls.forEach(function (el) { if (el.parentNode) el.parentNode.removeChild(el); });
        updateCount();
        if (!pending.length) paint();
      }

      function confirm(ev, clientId, rowEls, buttons) {
        buttons.forEach(function (b) { b.disabled = true; });
        api.calendarEvents.promote(ev.id, clientId).then(function (res) {
          var session = res && res.session;
          // Surface the session date so a timezone error is visible immediately.
          var when = session && session.session_date ? R.fmtDate(session.session_date) : null;
          R.toast(when ? 'Session created for ' + when : 'Session created', 'success');
          removeRow(ev, rowEls);
        }).catch(function (err) {
          buttons.forEach(function (b) { b.disabled = false; });
          R.toast(err.message || 'Could not confirm this appointment.', 'error');
        });
      }

      function ignore(ev, rowEls, buttons) {
        buttons.forEach(function (b) { b.disabled = true; });
        api.calendarEvents.ignore(ev.id).then(function () {
          R.toast('Appointment ignored', 'success');
          removeRow(ev, rowEls);
        }).catch(function (err) {
          buttons.forEach(function (b) { b.disabled = false; });
          R.toast(err.message || 'Could not ignore this appointment.', 'error');
        });
      }

      // The Client cell + action buttons for one row. mode 'suggested' shows the
      // matched client with Confirm / Change; 'picker' shows the searchable
      // client input with Confirm. Change re-renders the same row in picker mode.
      function paintRow(ev, row, mode) {
        R.clear(row);
        var buttons = [];
        var actions;
        var clientCell;

        var ignoreBtn = h('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          style: 'margin-left:var(--space-2)',
          onClick: function () { ignore(ev, [row], buttons); },
        }, 'Ignore');

        if (mode === 'suggested') {
          var confidence = ev.match_confidence != null
            ? Math.round(Number(ev.match_confidence)) + '%'
            : null;
          clientCell = h('td', null, [
            h('span', null, ev.matched_client_name || '—'),
            confidence
              ? h('span', { class: 'badge badge--neutral',
                  style: 'margin-left:var(--space-2)' }, confidence + ' match')
              : null,
          ]);
          var confirmBtn = h('button', {
            class: 'btn btn--primary btn--sm', type: 'button',
            onClick: function () { confirm(ev, ev.matched_client_id, [row], buttons); },
          }, 'Confirm');
          var changeBtn = h('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            style: 'margin-left:var(--space-2)',
            onClick: function () { paintRow(ev, row, 'picker'); },
          }, 'Change');
          buttons.push(confirmBtn, changeBtn, ignoreBtn);
          actions = h('td', { class: 'data-table__num' }, [confirmBtn, changeBtn, ignoreBtn]);
        } else {
          // Searchable select over the practice's active clients (native
          // datalist type-ahead). Confirm enables only on an exact pick.
          var listId = 'calendar-client-options-' + ev.id;
          var pickerConfirm = h('button', {
            class: 'btn btn--primary btn--sm', type: 'button', disabled: 'disabled',
          }, 'Confirm');
          var input = h('input', {
            class: 'field__control',
            type: 'text',
            list: listId,
            placeholder: clients.length ? 'Search clients…' : 'No active clients',
            'aria-label': 'Choose a client for this appointment',
            style: 'max-width:16rem;font-size:var(--font-size-2)',
            onInput: function (e) {
              pickerConfirm.disabled = !labelToId[e.target.value];
            },
          });
          if (!clients.length) input.disabled = true;
          pickerConfirm.addEventListener('click', function () {
            var clientId = labelToId[input.value];
            if (clientId) confirm(ev, clientId, [row], buttons);
          });
          clientCell = h('td', null, [
            input,
            h('datalist', { id: listId },
              pickerOptions.map(function (label) { return h('option', { value: label }); })),
          ]);
          buttons.push(pickerConfirm, ignoreBtn);
          actions = h('td', { class: 'data-table__num' }, [
            pickerConfirm,
            ignoreBtn,
          ]);
        }

        [
          h('td', null, R.fmtDate(ev.starts_at)),
          h('td', null, fmtTime(ev.starts_at)),
          h('td', null, ev.duration_minutes != null ? ev.duration_minutes + ' min' : '—'),
          h('td', null, ev.summary_raw || '—'),
          clientCell,
          actions,
        ].forEach(function (cell) { row.appendChild(cell); });
      }

      function paint() {
        R.clear(tbody);
        if (!pending.length) {
          tbody.appendChild(h('tr', null,
            h('td', { colspan: '6' },
              inlineEmpty('Nothing to review. Sync to pull in new appointments.'))));
          return;
        }
        pending.forEach(function (ev) {
          var row = h('tr');
          paintRow(ev, row, ev.match_state === 'matched' && ev.matched_client_id
            ? 'suggested' : 'picker');
          tbody.appendChild(row);
        });
      }

      var syncBtn = h('button', {
        class: 'btn btn--primary', type: 'button',
        onClick: function () {
          syncBtn.disabled = true;
          api.calendarEvents.sync().then(function () {
            R.toast('Calendar synced', 'success');
            load();
          }).catch(function (err) {
            syncBtn.disabled = false;
            R.toast(err.message || 'Could not sync your calendar.', 'error');
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
            'Staged appointments not yet confirmed will be cleared. ' +
            'Confirmed sessions are kept.'
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
              R.toast(err.message || 'Could not switch calendars.', 'error');
            });
        });
        calendarPicker = h('label', {
          style: 'display:inline-flex;align-items:center;gap:var(--space-2);' +
            'color:var(--color-text-muted);font-size:var(--font-size-2)',
        }, ['Syncing', picker]);
      }

      var table = h('table', { class: 'data-table' }, [
        h('thead', null, h('tr', null, [
          h('th', null, 'Date'),
          h('th', null, 'Time'),
          h('th', null, 'Duration'),
          h('th', null, 'Appointment'),
          h('th', null, 'Client'),
          h('th', { class: 'data-table__num' }, ''),
        ])),
        tbody,
      ]);

      updateCount();
      paint();

      root.appendChild(h('div', { class: 'view stack' }, [
        h('div', { class: 'page-header' }, [
          h('h1', { class: 'page-header__title' }, 'Calendar'),
          h('div', { class: 'page-header__actions' }, [calendarPicker, syncBtn]),
        ]),
        countEl,
        h('div', { class: 'card' }, table),
      ]));
    }

    load();
  }

  R.registerView('calendar', function (root) {
    return renderCalendar(root);
  });
})(window, document);
