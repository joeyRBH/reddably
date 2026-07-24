/* =============================================================================
 * Reddably — Clients workspace (list + detail with insurance & sessions)
 * =============================================================================
 * Registers under #clients (list) and #clients/<id> (detail). Built entirely on
 * the shared kit (window.Reddably) and ReddablyAPI — no direct fetch(), no raw
 * hex/px, no new globals. No PHI in hashes/URLs (client ids are UUIDs only).
 * Loaded after dashboard.js.
 * ========================================================================== */
(function (window, document) {
  'use strict';

  var R = window.Reddably;
  if (!R) return;

  var h = R.h;
  var api = R.api;

  // ---------------------------------------------------------------------------
  // Shared form field specs + value transforms
  // ---------------------------------------------------------------------------
  var CLIENT_FIELDS = [
    { name: 'first_name',     label: 'First name',     type: 'text',  required: true },
    { name: 'last_name',      label: 'Last name',      type: 'text',  required: true },
    { name: 'preferred_name', label: 'Preferred name', type: 'text' },
    { name: 'pronouns',       label: 'Pronouns',       type: 'text' },
    { name: 'email',          label: 'Email',          type: 'email' },
    { name: 'phone',          label: 'Mobile Phone',   type: 'text',
      placeholder: '(303) 555-0100',
      // Accept any common US format; normalize to E.164 (+1XXXXXXXXXX) on submit
      // — Twilio SMS (the payment-link flow) requires it. Backend re-validates.
      validate: function (v) {
        var P = window.ReddablyPhone;
        return (P && P.normalize(v).ok) ? null : 'Enter a valid US phone number.';
      },
      transform: function (v) {
        var P = window.ReddablyPhone;
        var r = P && P.normalize(v);
        return (r && r.ok) ? r.value : v;
      } },
    { name: 'date_of_birth',  label: 'Date of birth',  type: 'date' },
    { name: 'gender',         label: 'Biological Sex', type: 'select', required: true,
      options: [
        { value: 'male',    label: 'M' },
        { value: 'female',  label: 'F' },
        { value: 'unknown', label: 'U' },
      ] },
    { name: 'address_line1',  label: 'Address line 1', type: 'text', required: true },
    { name: 'address_line2',  label: 'Address line 2', type: 'text' },
    { name: 'city',           label: 'City',           type: 'text', required: true },
    { name: 'state',          label: 'State',          type: 'text', required: true },
    { name: 'postal_code',    label: 'Zip code',       type: 'text', required: true },
    { name: 'diagnosis_codes', label: 'Default diagnosis code(s)', type: 'diagnosis',
      placeholder: 'Search code or condition (e.g. F411 or anxiety)…' },
    // 'active' == ready for claim submission. Keep in sync with the CHECK in
    // db/schema.sql (§5 clients) and ALLOWED_STATUSES in backend/handlers/clients.js.
    { name: 'status',         label: 'Status',         type: 'select',
      options: ['awaiting_info', 'active', 'inactive'] },
  ];

  // The "New client" form omits date of birth, pronouns, and the full address —
  // the client supplies all of these themselves in the SMS intake ("Your
  // information" step), keeping PHI entry with the client and the New-client form
  // short. Staff can still add or correct every one of them later via the Edit
  // client form (which uses the full CLIENT_FIELDS). These are all optional on the
  // backend create, so omitting them never triggers a validation error.
  var CREATE_ONLY_OMITTED = [
    'date_of_birth', 'pronouns',
    'address_line1', 'address_line2', 'city', 'state', 'postal_code',
  ];
  var CREATE_CLIENT_FIELDS = CLIENT_FIELDS.filter(function (f) {
    return CREATE_ONLY_OMITTED.indexOf(f.name) === -1;
  });

  // A patient is a dependent (not the policyholder) when the stored relationship
  // is present and something other than 'self'. The 837P builder puts such a
  // patient in the dependent loop (2000C) and the policyholder in the subscriber
  // loop (2000B); these helpers surface that distinction in the UI.
  function isDependentRel(rel) {
    if (rel == null) return false;
    var r = String(rel).trim().toLowerCase();
    return r !== '' && r !== 'self';
  }

  function relationshipLabel(rel) {
    switch (String(rel || '').trim().toLowerCase()) {
      case 'child':  return 'child / dependent';
      case 'spouse': return 'spouse';
      case 'other':  return 'other';
      case 'self':   return 'self';
      default:       return rel;
    }
  }

  var INSURANCE_FIELDS = [
    { name: 'payer_id',                label: 'Payer ID',               type: 'payer',
      payerNameField: 'carrier_name',
      placeholder: 'Search payer name or enter a Payer ID…' },
    { name: 'member_id',               label: 'Member ID',              type: 'text' },
    { name: 'group_number',            label: 'Group number',           type: 'text' },
    { name: 'subscriber_relationship', label: "Patient's relationship to policyholder", type: 'select',
      options: [
        { value: 'self',   label: 'Patient is the policyholder' },
        { value: 'child',  label: 'Patient is a child / dependent' },
        { value: 'spouse', label: 'Patient is the spouse' },
        { value: 'other',  label: 'Other' },
      ] },
    { name: 'subscriber_name',         label: 'Policyholder name',        type: 'text',
      showIf: function (v) { return isDependentRel(v.subscriber_relationship); } },
    { name: 'subscriber_dob',          label: 'Policyholder date of birth', type: 'date',
      showIf: function (v) { return isDependentRel(v.subscriber_relationship); } },
    { name: 'subscriber_gender',       label: 'Policyholder sex (as on the policy)', type: 'select',
      options: [
        { value: '',        label: '—' },
        { value: 'female',  label: 'Female' },
        { value: 'male',    label: 'Male' },
        { value: 'unknown', label: 'Unknown' },
      ],
      hint: "The POLICYHOLDER's sex on the insurance policy — not the patient's. " +
        'Some payers require it on a dependent claim (CMS-1500 Box 11a).',
      showIf: function (v) { return isDependentRel(v.subscriber_relationship); } },
    // Policyholder address (CMS-1500 Box 7). Distinct from the patient's own
    // address — a dependent may live at a different address than the policyholder.
    // A "same as patient" convenience checkbox is spliced in ahead of these in
    // openForm (it needs the in-scope client's address to copy from).
    { name: 'subscriber_address_line1', label: 'Policyholder address line 1', type: 'text',
      hint: "The POLICYHOLDER's address — not the patient's. Leave blank if unknown.",
      showIf: function (v) { return isDependentRel(v.subscriber_relationship); } },
    { name: 'subscriber_address_line2', label: 'Policyholder address line 2', type: 'text',
      showIf: function (v) { return isDependentRel(v.subscriber_relationship); } },
    { name: 'subscriber_city',          label: 'Policyholder city',        type: 'text',
      showIf: function (v) { return isDependentRel(v.subscriber_relationship); } },
    { name: 'subscriber_state',         label: 'Policyholder state',       type: 'text',
      showIf: function (v) { return isDependentRel(v.subscriber_relationship); } },
    { name: 'subscriber_postal_code',   label: 'Policyholder ZIP',         type: 'text',
      showIf: function (v) { return isDependentRel(v.subscriber_relationship); } },
    { name: 'oon_deductible_total',    label: 'OON deductible total',   type: 'number' },
    { name: 'oon_deductible_met',      label: 'OON deductible met',     type: 'number' },
    { name: 'oon_reimbursement_rate',  label: 'OON reimbursement rate (%)', type: 'number' },
    { name: 'is_primary',              label: 'Primary insurance',      type: 'select',
      options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] },
  ];

  var SESSION_FIELDS = [
    { name: 'session_date',     label: 'Session date',   type: 'date', required: true },
    { name: 'cpt_code',         label: 'CPT code',       type: 'text' },
    { name: 'duration_minutes', label: 'Duration (min)', type: 'number' },
    { name: 'fee',              label: 'Fee',            type: 'number' },
    { name: 'place_of_service', label: 'Place of service', type: 'text' },
    { name: 'procedure_modifiers', label: 'Procedure modifiers', type: 'text',
      placeholder: '95, GT',
      hint: 'Optional payer-required modifiers, comma-separated. Example: 95 for ' +
        'some synchronous telehealth claims — verify payer requirements.',
      // Comma-separated text → an array of uppercased two-character codes. The
      // backend re-validates (≤4 entries, each exactly two alphanumeric chars,
      // trimmed, de-duplicated) and is authoritative; this just shapes the input.
      transform: function (v) {
        return String(v || '')
          .split(',')
          .map(function (s) { return s.trim().toUpperCase(); })
          .filter(Boolean);
      } },
    { name: 'diagnosis_codes',  label: 'Diagnosis code(s)', type: 'diagnosis',
      placeholder: 'Search code or condition (e.g. F411 or anxiety)…' },
    { name: 'status',           label: 'Status',         type: 'select',
      options: ['scheduled', 'completed', 'claim_ready', 'claim_submitted',
                'awaiting_payment', 'paid', 'no_claim'] },
  ];

  // Recurrence options for the Add Session form (create only). 'biweekly' is the
  // "every 2 weeks" cadence the backend expects.
  var RECURRENCE_OPTIONS = [
    { value: 'none',     label: 'Does not repeat' },
    { value: 'weekly',   label: 'Weekly' },
    { value: 'biweekly', label: 'Every 2 weeks' },
  ];

  // 'YYYY-MM-DD' six months from today — the max "Repeat until" the picker offers.
  // The backend independently enforces the 6-month bound relative to session_date.
  function sixMonthsOut() {
    var d = new Date();
    d.setMonth(d.getMonth() + 6);
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  // Drop null / undefined / '' keys so optional fields are omitted, not blanked.
  function compact(obj) {
    var out = {};
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      if (v === null || v === undefined || v === '') return;
      out[k] = v;
    });
    return out;
  }

  // Split the diagnosis picker's comma-joined value into an array of dotless
  // codes. '' → [] (empty array clears the column on the backend).
  function splitCodes(value) {
    return String(value || '')
      .split(',')
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  // Build the API payload for a client create/edit: compact the plain fields, then
  // map the diagnosis picker's comma string to an array. On edit we always send
  // diagnosis_codes (even empty) so clearing all codes persists; on create we omit
  // it when empty. `isEdit` controls that.
  function buildClientPayload(values, isEdit) {
    var payload = compact(values);
    delete payload.diagnosis_codes;
    var codes = splitCodes(values.diagnosis_codes);
    if (codes.length || isEdit) payload.diagnosis_codes = codes;
    return payload;
  }

  function clientName(c) {
    return c.preferred_name || ((c.first_name || '') + ' ' + (c.last_name || '')).trim();
  }

  // ---------------------------------------------------------------------------
  // Small shared building blocks
  // ---------------------------------------------------------------------------
  function inlineEmpty(text) {
    return h('p', {
      class: 'empty-state__body',
      style: 'margin:0;padding:var(--space-3) 0',
    }, text);
  }

  // A per-row action cell with Edit / Delete buttons.
  function rowActions(onEdit, onDelete) {
    return h('td', { class: 'data-table__num' }, [
      h('button', { class: 'btn btn--ghost btn--sm', type: 'button',
        onClick: function (e) { e.stopPropagation(); onEdit(); } }, 'Edit'),
      ' ',
      h('button', { class: 'btn btn--danger btn--sm', type: 'button',
        style: 'margin-left:var(--space-2)',
        onClick: function (e) { e.stopPropagation(); onDelete(); } }, 'Delete'),
    ]);
  }

  // ===========================================================================
  // Screen 1 — Client list (#clients)
  // ===========================================================================
  function renderClientList(root) {
    R.renderLoading(root);

    function load() {
      R.renderLoading(root);
      api.clients.list().then(function (res) {
        render((res && res.clients) || []);
      }).catch(function (err) {
        R.renderError(root, err, load);
      });
    }

    function openCreate() {
      R.formModal({
        title: 'New client',
        fields: CREATE_CLIENT_FIELDS,
        submitLabel: 'Create client',
      }).then(function (values) {
        if (!values) return;
        api.clients.create(buildClientPayload(values, false)).then(function () {
          R.toast('Client created', 'success');
          load();
        }).catch(function (err) {
          R.toast(err.message, 'error');
        });
      });
    }

    function render(clients) {
      R.clear(root);

      if (!clients.length) {
        R.renderEmpty(root, {
          title: 'No clients yet',
          body: 'Add your first client to start tracking insurance and sessions.',
          actionLabel: 'New client',
          onAction: openCreate,
        });
        return;
      }

      var tbody = h('tbody');

      function paint(filter) {
        R.clear(tbody);
        var needle = (filter || '').trim().toLowerCase();
        var rows = clients.filter(function (c) {
          if (!needle) return true;
          var hay = (clientName(c) + ' ' + (c.email || '')).toLowerCase();
          return hay.indexOf(needle) !== -1;
        });

        if (!rows.length) {
          tbody.appendChild(h('tr', null,
            h('td', { colspan: '3' }, inlineEmpty('No clients match your filter.'))));
          return;
        }

        rows.forEach(function (c) {
          var row = h('tr', {
            class: 'data-table__row--clickable',
            tabindex: '0',
            role: 'link',
          }, [
            h('td', null, clientName(c)),
            h('td', null, R.statusBadge(c.status)),
            h('td', null, R.fmtDate(c.created_at)),
          ]);
          function go() { R.navigate('clients/' + c.id); }
          row.addEventListener('click', go);
          row.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
          });
          tbody.appendChild(row);
        });
      }

      var filterInput = h('input', {
        class: 'field__control',
        type: 'search',
        placeholder: 'Filter by name or email…',
        'aria-label': 'Filter clients',
        style: 'max-width:22rem',
        onInput: function (e) { paint(e.target.value); },
      });

      var table = h('table', { class: 'data-table' }, [
        h('thead', null, h('tr', null, [
          h('th', null, 'Name'),
          h('th', null, 'Status'),
          h('th', null, 'Created'),
        ])),
        tbody,
      ]);

      paint('');

      var view = h('div', { class: 'view stack' }, [
        h('div', { class: 'page-header' }, [
          h('h1', { class: 'page-header__title' }, 'Clients'),
          h('div', { class: 'page-header__actions' }, [
            h('button', { class: 'btn btn--primary', type: 'button', onClick: openCreate },
              'New client'),
          ]),
        ]),
        filterInput,
        h('div', { class: 'card' }, table),
      ]);

      root.appendChild(view);
    }

    load();
  }

  // ===========================================================================
  // Screen 2 — Client detail (#clients/<id>)
  // ===========================================================================
  function renderClientDetail(root, id) {
    R.renderLoading(root);

    function backLink() {
      return h('a', {
        href: '#clients',
        class: 'btn btn--ghost btn--sm',
        style: 'align-self:flex-start',
      }, '← Clients');
    }

    function load() {
      R.renderLoading(root);
      Promise.all([
        api.clients.get(id),
        api.insuranceRecords.list({ client_id: id }),
        api.sessions.list({ client_id: id }),
      ]).then(function (results) {
        var client = results[0] && results[0].client;
        if (!client) {
          var notFound = new Error('Client not found.');
          throw notFound;
        }
        render(
          client,
          (results[1] && results[1].insurance_records) || [],
          (results[2] && results[2].sessions) || []
        );
      }).catch(function (err) {
        if (err && err.status === 404) {
          R.clear(root);
          root.appendChild(h('div', { class: 'view stack' }, [
            backLink(),
            h('div', { class: 'empty-state' }, [
              h('h1', { class: 'empty-state__title' }, 'Client not found'),
              h('p', { class: 'empty-state__body' },
                'This client may have been removed.'),
            ]),
          ]));
          return;
        }
        R.renderError(root, err, load);
      });
    }

    // --- Header card ---------------------------------------------------------
    function openEdit(client) {
      R.formModal({
        title: 'Edit client',
        fields: CLIENT_FIELDS,
        values: client,
        submitLabel: 'Save changes',
      }).then(function (values) {
        if (!values) return;
        api.clients.update(id, buildClientPayload(values, true)).then(function () {
          R.toast('Client updated', 'success');
          load();
        }).catch(function (err) {
          R.toast(err.message, 'error');
        });
      });
    }

    // --- Read-only View (no Edit form) --------------------------------------
    // A definition-list summary of the client's demographics, address, diagnosis,
    // and insurance. "Edit client" in the footer hands off to the edit form.
    function openView(client, insurance) {
      var Dx = window.ReddablyDiagnoses;

      function fmtGender(g) {
        return g === 'male' ? 'Male' : g === 'female' ? 'Female'
          : g === 'unknown' ? 'Unknown' : '—';
      }

      // One label/value row; value falls back to an em dash when blank.
      function row(label, value) {
        var shown = (value === null || value === undefined || value === '') ? '—' : value;
        return h('div', {
          style: 'display:flex;justify-content:space-between;gap:var(--space-4);'
            + 'padding:var(--space-1) 0',
        }, [
          h('span', { style: 'color:var(--color-text-muted);font-size:var(--font-size-2)' }, label),
          h('span', { style: 'text-align:right' }, shown),
        ]);
      }

      function section(title, rows) {
        return h('div', { class: 'stack', style: 'gap:var(--space-1)' }, [
          h('h3', {
            style: 'margin:0;font-size:var(--font-size-2);text-transform:uppercase;'
              + 'letter-spacing:0.04em;color:var(--color-text-muted)',
          }, title),
          h('div', null, rows),
        ]);
      }

      var addressParts = [client.address_line1, client.address_line2,
        [client.city, client.state].filter(Boolean).join(', '), client.postal_code]
        .filter(function (s) { return s != null && String(s).trim() !== ''; });

      var codes = Array.isArray(client.diagnosis_codes) ? client.diagnosis_codes : [];
      var dxValue = codes.length
        ? h('span', { style: 'text-align:right' },
            codes.map(function (c) { return Dx ? Dx.label(c) : c; }).join('; '))
        : '—';

      var insuranceRows;
      if (insurance && insurance.length) {
        insuranceRows = [];
        insurance.forEach(function (r) {
          var bits = [r.payer_id ? 'Payer ' + r.payer_id : 'Insurance'];
          if (r.member_id) bits.push('Member ' + r.member_id);
          if (r.oon_reimbursement_rate != null) bits.push(r.oon_reimbursement_rate + '% OON');
          insuranceRows.push(row(r.is_primary ? 'Primary' : 'Secondary', bits.join('  ·  ')));
          if (isDependentRel(r.subscriber_relationship)) {
            var holder = [r.subscriber_name || '—'];
            if (r.subscriber_dob) holder.push('· DOB ' + R.fmtDate(r.subscriber_dob));
            insuranceRows.push(row(
              'Policyholder (patient is ' + relationshipLabel(r.subscriber_relationship) + ')',
              holder.join(' ')));
          }
        });
      } else {
        insuranceRows = [row('Insurance', 'None on file')];
      }

      var body = h('div', { class: 'stack', style: 'gap:var(--space-4)' }, [
        section('Demographics', [
          row('Name', clientName(client)),
          row('Preferred name', client.preferred_name),
          row('Pronouns', client.pronouns),
          row('Email', client.email),
          row('Phone', client.phone),
          row('Date of birth', client.date_of_birth ? R.fmtDate(client.date_of_birth) : '—'),
          row('Biological sex', fmtGender(client.gender)),
          row('Status', R.statusBadge(client.status)),
        ]),
        section('Address', [
          row('Address', addressParts.length ? addressParts.join(', ') : '—'),
        ]),
        section('Diagnosis', [row('Default code(s)', dxValue)]),
        section('Insurance', insuranceRows),
      ]);

      R.confirmModal({
        title: clientName(client),
        body: body,
        confirmLabel: 'Edit client',
        cancelLabel: 'Close',
      }).then(function (edit) {
        if (edit) openEdit(client);
      });
    }

    function openDelete(client) {
      R.confirmModal({
        title: 'Delete client?',
        body: 'This hides the client and their records.',
        confirmLabel: 'Delete',
        danger: true,
      }).then(function (ok) {
        if (!ok) return;
        api.clients.remove(id).then(function () {
          R.toast('Client deleted', 'success');
          R.navigate('clients');
        }).catch(function (err) {
          R.toast(err.message, 'error');
        });
      });
    }

    // Send the SMS card-capture link, with a generic success/error toast.
    function sendPaymentLink(client) {
      api.clients.sendPaymentLink(client.id).then(function () {
        R.toast('Payment link sent to ' + (client.phone || 'the client'), 'success');
      }).catch(function (err) {
        R.toast(err.message || 'Could not send payment link', 'error');
      });
    }

    // Billing row: a saved-card badge (with "Send new link") or a "Send Payment Link"
    // button. Hidden entirely when there is no phone and no card on file.
    function billingRow(client) {
      var hasCard = !!client.payment_method_last4;
      var hasPhone = !!(client.phone && String(client.phone).trim());
      if (!hasCard && !hasPhone) return null;

      var children = [];

      if (hasCard) {
        var brand = client.payment_method_brand || 'card';
        var exp = (client.payment_method_exp_month && client.payment_method_exp_year)
          ? ' (exp ' + client.payment_method_exp_month + '/' + client.payment_method_exp_year + ')'
          : '';
        children.push(h('span', { class: 'badge badge--success' },
          '💳 Card on file: ' + brand + ' •••• ' + client.payment_method_last4 + exp));
        if (hasPhone) {
          children.push(h('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            style: 'margin-left:var(--space-3)',
            onClick: function () { sendPaymentLink(client); },
          }, 'Send new link'));
        }
      } else {
        children.push(h('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          onClick: function () { sendPaymentLink(client); },
        }, 'Send Payment Link'));
      }

      return h('div', {
        style: 'display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap;'
          + 'margin-top:var(--space-3);padding-top:var(--space-3);'
          + 'border-top:var(--border-width-1) solid var(--color-border)',
      }, children);
    }

    function headerCard(client, insurance) {
      var meta = [];
      if (client.email) meta.push(client.email);
      if (client.phone) meta.push(client.phone);
      if (client.date_of_birth) meta.push('DOB ' + R.fmtDate(client.date_of_birth));

      // Primary insurance = the record flagged is_primary, else the first on file.
      var records = insurance || [];
      var primary = null;
      for (var i = 0; i < records.length; i++) {
        if (records[i].is_primary) { primary = records[i]; break; }
      }
      if (!primary && records.length) primary = records[0];
      var dependentPrimary = primary && isDependentRel(primary.subscriber_relationship);
      if (dependentPrimary) {
        meta.push('Policyholder: ' + (primary.subscriber_name || '—')
          + ' (patient is ' + relationshipLabel(primary.subscriber_relationship) + ')');
      }

      return h('div', { class: 'card' }, [
        h('div', { class: 'card__header' }, [
          h('div', { style: 'display:flex;align-items:center;gap:var(--space-3);flex-wrap:wrap' }, [
            h('h1', { class: 'page-header__title' }, clientName(client)),
            R.statusBadge(client.status),
            dependentPrimary ? h('span', { class: 'badge badge--neutral' }, 'Dependent') : null,
          ]),
          h('div', { class: 'page-header__actions' }, [
            h('button', { class: 'btn btn--ghost', type: 'button',
              onClick: function () { openView(client, insurance); } }, 'View'),
            h('button', { class: 'btn btn--ghost', type: 'button',
              onClick: function () { openEdit(client); } }, 'Edit'),
            h('button', { class: 'btn btn--danger', type: 'button',
              onClick: function () { openDelete(client); } }, 'Delete'),
          ]),
        ]),
        meta.length
          ? h('p', { style: 'margin:0;color:var(--color-text-muted);font-size:var(--font-size-3)' },
              meta.join('  ·  '))
          : null,
        billingRow(client),
      ]);
    }

    // --- Panel A: Insurance --------------------------------------------------
    function insurancePanel(client, initialRecords) {
      var body = h('div');

      function reload() {
        api.insuranceRecords.list({ client_id: id }).then(function (res) {
          paint((res && res.insurance_records) || []);
        }).catch(function (err) {
          R.clear(body);
          body.appendChild(inlineEmpty(err.message || 'Could not load insurance.'));
        });
      }

      function openForm(record) {
        // Normalize the record into the shape the form inputs expect: the API
        // returns is_primary as a boolean and subscriber_dob as a timestamp, but
        // the select wants 'true'/'false' strings and the date input wants a bare
        // YYYY-MM-DD. payer_id passes through so the payer picker prefills.
        var values;
        if (record) {
          values = {};
          Object.keys(record).forEach(function (k) { values[k] = record[k]; });
          values.is_primary = record.is_primary ? 'true' : 'false';
          if (record.subscriber_dob) {
            values.subscriber_dob = String(record.subscriber_dob).slice(0, 10);
          }
        } else {
          values = { is_primary: 'true' };
        }
        // "Same as patient" convenience for the policyholder address: a UI-only
        // checkbox that copies THIS client's own address into the policyholder
        // address fields. Built here (not in the static INSURANCE_FIELDS) so it can
        // close over the in-scope `client`. Spliced in just before the address
        // lines, and only visible in dependent mode.
        var sameAsPatient = {
          name: '_subscriber_addr_same_as_patient',
          label: "Policyholder's address is the same as the patient's",
          type: 'checkbox',
          uiOnly: true,
          showIf: function (v) { return isDependentRel(v.subscriber_relationship); },
          onToggle: function (checked, controls) {
            if (!checked) return;
            var map = {
              subscriber_address_line1: client.address_line1,
              subscriber_address_line2: client.address_line2,
              subscriber_city: client.city,
              subscriber_state: client.state,
              subscriber_postal_code: client.postal_code,
            };
            Object.keys(map).forEach(function (name) {
              if (controls[name]) controls[name].value = map[name] || '';
            });
          },
        };
        var fields = [];
        INSURANCE_FIELDS.forEach(function (f) {
          if (f.name === 'subscriber_address_line1') fields.push(sameAsPatient);
          fields.push(f);
        });
        R.formModal({
          title: record ? 'Edit insurance' : 'Add insurance',
          fields: fields,
          values: values,
          submitLabel: record ? 'Save changes' : 'Add insurance',
        }).then(function (values) {
          if (!values) return;
          var payload = compact(values);
          if (values.is_primary !== null && values.is_primary !== undefined) {
            payload.is_primary = values.is_primary === 'true';
          }
          if (!record) payload.client_id = id;   // create only — immutable on update
          var p = record
            ? api.insuranceRecords.update(record.id, payload)
            : api.insuranceRecords.create(payload);
          p.then(function () {
            R.toast(record ? 'Insurance updated' : 'Insurance added', 'success');
            reload();
          }).catch(function (err) {
            R.toast(err.message, 'error');
          });
        });
      }

      function openDeleteRecord(record) {
        R.confirmModal({
          title: 'Delete insurance?',
          body: 'This hides the insurance record.',
          confirmLabel: 'Delete',
          danger: true,
        }).then(function (ok) {
          if (!ok) return;
          api.insuranceRecords.remove(record.id).then(function () {
            R.toast('Insurance deleted', 'success');
            reload();
          }).catch(function (err) {
            R.toast(err.message, 'error');
          });
        });
      }

      // --- Instant VOB (Verification of Benefits) --------------------------
      // Gate on the cached plan (window.ReddablyPlan). Free practices get an
      // upgrade prompt; vob/founder practices open the benefit-check flow.
      function verifyBenefits(record) {
        var P = window.ReddablyPlan;
        function decide(plan) {
          if (plan === 'vob' || plan === 'founder') openVobModal(record);
          else openUpgradeModal();
        }
        if (P && P.state && P.state.loaded) {
          decide(P.get());
        } else if (P && typeof P.refresh === 'function') {
          // Plan not cached yet — fetch once, then gate.
          P.refresh().then(function () { decide(P.get()); }).catch(function () { decide('free'); });
        } else {
          decide('free');
        }
      }

      function openUpgradeModal() {
        var pitch = h('div', { class: 'stack', style: 'gap:var(--space-2)' }, [
          h('p', { style: 'margin:0' }, 'Unlock Instant VOB for $25/month.'),
          h('p', { style: 'margin:0;color:var(--color-text-muted)' },
            "Know your client's OON benefits before the first session."),
        ]);
        R.confirmModal({
          title: 'Instant VOB',
          body: pitch,
          confirmLabel: 'Activate for $25/mo',
          cancelLabel: 'Not now',
        }).then(function (ok) {
          if (!ok) return;
          api.subscription.activateVob().then(function (res) {
            if (res && res.checkoutUrl) {
              window.location.assign(res.checkoutUrl);
            } else {
              R.toast('Could not start checkout.', 'error');
            }
          }).catch(function (err) {
            R.toast(err.message || 'Could not start checkout.', 'error');
          });
        });
      }

      function dateOnly(v) {
        return v ? String(v).slice(0, 10) : '';
      }

      function openVobModal(record) {
        // When the patient is a dependent on someone else's policy, the payer
        // matches on the policyholder — so we collect who the policyholder is and
        // reveal their demographics. Prefill "No" when the stored subscriber
        // relationship is anything other than self.
        function onlyDependentFields(v) {
          return v.patient_is_subscriber === 'false';
        }
        var fields = [
          { name: 'member_id',     label: 'Member ID',     type: 'text', required: true },
          { name: 'payer_id',      label: 'Payer ID',      type: 'payer', required: true,
            payerNameField: 'carrier_name',
            placeholder: 'Search payer name or enter a Payer ID…' },
          { name: 'first_name',    label: 'First name',    type: 'text', required: true },
          { name: 'last_name',     label: 'Last name',     type: 'text', required: true },
          { name: 'date_of_birth', label: 'Date of birth', type: 'date', required: true },
          { name: 'patient_is_subscriber', label: 'Patient is the policyholder', type: 'select',
            options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] },
          { name: 'subscriber_first_name', label: 'Policyholder first name', type: 'text',
            showIf: onlyDependentFields },
          { name: 'subscriber_last_name',  label: 'Policyholder last name',  type: 'text',
            showIf: onlyDependentFields },
          { name: 'subscriber_dob',        label: 'Policyholder date of birth', type: 'date',
            showIf: onlyDependentFields },
        ];
        // Split the stored subscriber name on the LAST space → first / last
        // (a single token becomes a first name only).
        var subName = String(record.subscriber_name || '').trim();
        var subFirst = subName;
        var subLast = '';
        var lastSpace = subName.lastIndexOf(' ');
        if (lastSpace > 0) {
          subFirst = subName.slice(0, lastSpace).trim();
          subLast = subName.slice(lastSpace + 1).trim();
        }
        var rel = record.subscriber_relationship;
        var isSelf = !rel || rel === 'self';
        var values = {
          member_id: record.member_id || '',
          payer_id: record.payer_id || '',
          first_name: client.first_name || '',
          last_name: client.last_name || '',
          // Patient DOB comes ONLY from the client record (or stays empty). It must
          // never fall back to the policyholder's DOB — on a dependent policy the
          // subscriber_dob is a different person, and prefilling it here would send
          // the wrong patient date of birth to the payer.
          date_of_birth: dateOnly(client.date_of_birth),
          patient_is_subscriber: isSelf ? 'true' : 'false',
          subscriber_first_name: subFirst,
          subscriber_last_name: subLast,
          subscriber_dob: dateOnly(record.subscriber_dob),
        };
        R.formModal({
          title: 'Verify benefits',
          fields: fields,
          values: values,
          submitLabel: 'Check Now',
        }).then(function (v) {
          if (!v) return;
          R.toast('Checking benefits…', '');
          api.vob.check({
            memberId: v.member_id,
            payerId: v.payer_id,
            firstName: v.first_name,
            lastName: v.last_name,
            dateOfBirth: v.date_of_birth,
            patientIsSubscriber: v.patient_is_subscriber === 'true',
            subscriberFirstName: v.subscriber_first_name,
            subscriberLastName: v.subscriber_last_name,
            subscriberDateOfBirth: v.subscriber_dob,
            insurance_record_id: record.id,
          }).then(function (res) {
            showVobResult(res, record, res && res.discrepancies);
            // Persist the payer id (and picked payer name) used for this check
            // back onto the record when it had none — closes the gap where a payer
            // chosen only in the VOB modal was never saved, which later makes the
            // 837P receiver name empty. Best-effort; failure just skips the write.
            var upd = {};
            if (!record.payer_id && v.payer_id) upd.payer_id = v.payer_id;
            if (!record.carrier_name && v.carrier_name) upd.carrier_name = v.carrier_name;
            if (Object.keys(upd).length) {
              api.insuranceRecords.update(record.id, upd).then(reload, reload);
            } else {
              reload();
            }
          }).catch(function (err) {
            if (err && err.status === 403 && err.body && err.body.upgrade) {
              openUpgradeModal();
              return;
            }
            R.toast(err.message || 'Benefit check failed.', 'error');
          });
        });
      }

      // A labeled "met / total" progress bar built from design tokens only.
      function meter(label, met, total) {
        var pct = (total != null && total > 0 && met != null)
          ? Math.max(0, Math.min(100, (met / total) * 100))
          : 0;
        return h('div', { class: 'stack', style: 'gap:var(--space-1)' }, [
          h('div', { style: 'display:flex;justify-content:space-between;font-size:var(--font-size-2)' }, [
            h('span', null, label),
            h('span', { style: 'color:var(--color-text-muted)' },
              (met != null ? R.fmtMoney(met) : '—') + ' / ' + (total != null ? R.fmtMoney(total) : '—')),
          ]),
          h('div', {
            style: 'height:8px;border-radius:var(--radius-pill);'
              + 'background:var(--color-surface-sunken);overflow:hidden',
          }, h('div', {
            style: 'height:100%;width:' + pct + '%;background:var(--color-primary)',
          })),
        ]);
      }

      // --- Payer-record reconciliation ------------------------------------
      // The VOB check compares the payer's echoed demographics against our stored
      // records; differences come back as res.discrepancies (live) and, derived
      // from the stored check, record.benefits_discrepancies (persistent). Member
      // ID corrections update the insurance record; patient name/DOB corrections
      // update the client record. Nothing is applied without an explicit confirm.
      var DISCREPANCY_FIELD_LABELS = {
        member_id: 'Member ID',
        subscriber_name: 'Policyholder name',
        subscriber_dob: 'Policyholder DOB',
        first_name: 'First name',
        last_name: 'Last name',
        date_of_birth: 'Date of birth',
      };
      var INSURANCE_FIELDS = { member_id: 1, subscriber_name: 1, subscriber_dob: 1 };
      var CLIENT_FIELDS = { first_name: 1, last_name: 1, date_of_birth: 1 };

      function fieldLabel(f) { return DISCREPANCY_FIELD_LABELS[f] || f; }

      function applyCorrections(record, discrepancies) {
        var insUpd = {};
        var cliUpd = {};
        (discrepancies || []).forEach(function (d) {
          if (!d || !d.field) return;
          if (INSURANCE_FIELDS[d.field]) insUpd[d.field] = d.payer_returned;
          else if (CLIENT_FIELDS[d.field]) cliUpd[d.field] = d.payer_returned;
        });
        if (!Object.keys(insUpd).length && !Object.keys(cliUpd).length) return;

        var summary = (discrepancies || []).map(function (d) {
          return h('li', { style: 'margin:0 0 var(--space-1)' },
            fieldLabel(d.field) + ' → ' + (d.payer_returned || '—'));
        });
        R.confirmModal({
          title: 'Apply payer corrections?',
          body: h('div', { class: 'stack', style: 'gap:var(--space-2)' }, [
            h('p', { style: 'margin:0' }, 'Update the stored records to match the payer:'),
            h('ul', { style: 'margin:0;padding-left:var(--space-5)' }, summary),
          ]),
          confirmLabel: 'Apply corrections',
          cancelLabel: 'Cancel',
        }).then(function (ok) {
          if (!ok) return;
          var calls = [];
          // Only the differing fields are sent; each update endpoint is audited
          // (action + field NAMES only, no PHI values).
          if (Object.keys(insUpd).length) calls.push(api.insuranceRecords.update(record.id, insUpd));
          if (Object.keys(cliUpd).length) calls.push(api.clients.update(id, cliUpd));
          Promise.all(calls).then(function () {
            R.toast('Records updated to match the payer', 'success');
            reload();
          }).catch(function (err) {
            R.toast((err && err.message) || 'Could not apply corrections.', 'error');
          });
        });
      }

      // The "Payer records differ" panel. Returns null when there is nothing to
      // reconcile. Shared by the live result modal and the persistent row.
      function discrepancyPanel(record, discrepancies) {
        if (!discrepancies || !discrepancies.length) return null;
        var rows = discrepancies.map(function (d) {
          return h('tr', null, [
            h('td', null, fieldLabel(d.field)),
            h('td', { style: 'color:var(--color-text-muted)' }, d.stored || '—'),
            h('td', { style: 'font-weight:var(--font-weight-medium)' }, d.payer_returned || '—'),
          ]);
        });
        return h('div', {
          class: 'stack',
          style: 'gap:var(--space-3);padding:var(--space-3);border-radius:var(--radius-2);'
            + 'background:var(--color-surface-sunken);'
            + 'border-left:3px solid var(--color-warning)',
        }, [
          h('div', { style: 'display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap' }, [
            h('span', { class: 'badge badge--warning' }, 'Payer records differ'),
            h('span', { style: 'color:var(--color-text-muted);font-size:var(--font-size-2)' },
              'The payer returned different details than we have on file.'),
          ]),
          h('table', { class: 'data-table' }, [
            h('thead', null, h('tr', null, [
              h('th', null, 'Field'),
              h('th', null, 'On file'),
              h('th', null, 'Payer'),
            ])),
            h('tbody', null, rows),
          ]),
          h('div', null, h('button', {
            class: 'btn btn--primary btn--sm', type: 'button',
            onClick: function (e) { e.stopPropagation(); applyCorrections(record, discrepancies); },
          }, 'Apply payer corrections')),
        ]);
      }

      // Persistent sub-row beneath an insurance row, from the stored check.
      function discrepancyRow(record) {
        var panel = discrepancyPanel(record, record.benefits_discrepancies);
        if (!panel) return null;
        return h('tr', null, h('td', { colspan: '5', style: 'padding-top:0' }, panel));
      }

      // Sub-row that spells out the policyholder when the patient is a dependent
      // on someone else's plan — the claim is billed under this subscriber, and
      // the patient rides along in the 837P dependent loop. Null when self.
      function policyholderRow(record) {
        if (!isDependentRel(record.subscriber_relationship)) return null;
        var parts = ['Billed under policyholder: ' + (record.subscriber_name || '—')];
        parts.push('Patient is ' + relationshipLabel(record.subscriber_relationship)
          + ' of the policyholder');
        if (record.subscriber_dob) parts.push('DOB ' + R.fmtDate(record.subscriber_dob));
        var box = h('div', {
          style: 'padding:var(--space-3);border-radius:var(--radius-2);'
            + 'background:var(--color-surface-sunken);'
            + 'color:var(--color-text-muted);font-size:var(--font-size-2)',
        }, parts.join('  ·  '));
        return h('tr', null, h('td', { colspan: '5', style: 'padding-top:0' }, box));
      }

      // Status badge shared by the live modal and the persistent summary card.
      // A payer rejection (AAA error) is not the same as inactive coverage: the
      // payer refused the request, so the status is unknown, not "Inactive".
      function vobStatusBadge(res) {
        // Unknown (payer rejected the request, or the 271 gave no status either
        // way → active == null) is NOT the same as inactive coverage.
        if (res.rejected || res.active == null) {
          return h('span', { class: 'badge badge--warning' }, 'Could not verify');
        }
        return res.active
          ? h('span', { class: 'badge badge--success' }, 'Active coverage')
          : h('span', { class: 'badge badge--danger' }, 'Inactive');
      }

      // Render the full benefit result — used both for a fresh check response and
      // for a stored summary reopened from the insurance row (same shape). When a
      // record + discrepancies are passed, the reconciliation panel is appended.
      function showVobResult(res, record, discrepancies) {
        res = res || {};
        var ded = res.deductible || {};
        var oop = res.outOfPocket || {};

        var rejection = (res.rejected && res.rejections && res.rejections[0]) || null;
        var statusBadge = vobStatusBadge(res);

        var children = [
          h('div', { style: 'display:flex;align-items:center;gap:var(--space-3);flex-wrap:wrap' }, [
            statusBadge,
            res.planName ? h('span', { style: 'font-weight:var(--font-weight-medium)' }, res.planName) : null,
          ]),
        ];

        if (rejection) {
          var detail = [rejection.description, rejection.followupAction]
            .filter(function (s) { return s != null && String(s).trim() !== ''; })
            .join(' — ');
          if (detail) {
            children.push(h('p', {
              style: 'margin:0;color:var(--color-text-muted);font-size:var(--font-size-2)',
            }, detail));
          }
        }

        var facts = [];
        if (res.groupNumber) facts.push('Group ' + res.groupNumber);
        if (res.oonBenefits) facts.push('OON benefits');
        if (res.oonCoinsurance != null) facts.push('OON coinsurance ' + res.oonCoinsurance + '%');
        if (facts.length) {
          children.push(h('p', {
            style: 'margin:0;color:var(--color-text-muted);font-size:var(--font-size-3)',
          }, facts.join('  ·  ')));
        }

        children.push(meter('Deductible (individual)', ded.met, ded.individual));
        children.push(meter('Out-of-pocket (individual)', oop.met, oop.individual));

        var panel = record ? discrepancyPanel(record, discrepancies) : null;
        if (panel) children.push(panel);

        var bodyNode = h('div', { class: 'stack', style: 'gap:var(--space-4)' }, children);
        R.confirmModal({
          title: 'Benefits',
          body: bodyNode,
          confirmLabel: 'Done',
          cancelLabel: 'Close',
        });
      }

      // A persistent, full-width summary of the last stored VOB result, shown as
      // a sub-row beneath its insurance row. Returns null when the record has no
      // stored check (benefits_summary is computed server-side from benefits_raw).
      function vobSummaryRow(record) {
        var s = record.benefits_summary;
        if (!s) return null;
        var ded = s.deductible || {};
        var oop = s.outOfPocket || {};

        function amount(label, pair) {
          if (pair.individual == null) return null;
          var value = (pair.met != null ? R.fmtMoney(pair.met) + ' / ' : '') + R.fmtMoney(pair.individual);
          return label + ' ' + value;
        }
        var facts = [amount('Deductible', ded), amount('Out-of-pocket', oop)]
          .filter(function (t) { return t != null; });

        var lines = [
          h('div', { style: 'display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap' }, [
            vobStatusBadge(s),
            s.planName ? h('span', { style: 'font-weight:var(--font-weight-medium)' }, s.planName) : null,
          ]),
        ];
        if (facts.length) {
          lines.push(h('div', {
            style: 'color:var(--color-text-muted);font-size:var(--font-size-2)',
          }, facts.join('  ·  ')));
        }
        lines.push(h('div', {
          style: 'display:flex;align-items:center;justify-content:space-between;'
            + 'gap:var(--space-2);flex-wrap:wrap',
        }, [
          h('span', { style: 'color:var(--color-text-muted);font-size:var(--font-size-2)' },
            'Last verified ' + R.fmtDate(record.benefits_checked_at)),
          h('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            onClick: function (e) { e.stopPropagation(); showVobResult(s, record, record.benefits_discrepancies); },
          }, 'View result'),
        ]));

        var box = h('div', {
          class: 'stack',
          style: 'gap:var(--space-2);padding:var(--space-3);border-radius:var(--radius-2);'
            + 'background:var(--color-surface-sunken)',
        }, lines);

        return h('tr', null, h('td', { colspan: '5', style: 'padding-top:0' }, box));
      }

      // A per-row action cell: Verify / Edit / Delete.
      function insuranceRowActions(record) {
        return h('td', { class: 'data-table__num' }, [
          h('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            onClick: function (e) { e.stopPropagation(); verifyBenefits(record); },
          }, 'Verify'),
          ' ',
          h('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            style: 'margin-left:var(--space-2)',
            onClick: function (e) { e.stopPropagation(); openForm(record); },
          }, 'Edit'),
          ' ',
          h('button', {
            class: 'btn btn--danger btn--sm', type: 'button',
            style: 'margin-left:var(--space-2)',
            onClick: function (e) { e.stopPropagation(); openDeleteRecord(record); },
          }, 'Delete'),
        ]);
      }

      function paint(records) {
        R.clear(body);
        if (!records.length) {
          body.appendChild(inlineEmpty('No insurance on file'));
          return;
        }
        var rows = [];
        records.forEach(function (r) {
          rows.push(h('tr', null, [
            h('td', null, r.payer_id || '—'),
            h('td', null, r.member_id || '—'),
            h('td', null, r.is_primary
              ? h('span', { class: 'badge badge--success' }, 'Primary')
              : '—'),
            h('td', null, r.oon_reimbursement_rate != null
              ? r.oon_reimbursement_rate + '%'
              : '—'),
            insuranceRowActions(r),
          ]));
          var holder = policyholderRow(r);
          if (holder) rows.push(holder);
          var summary = vobSummaryRow(r);
          if (summary) rows.push(summary);
          var disc = discrepancyRow(r);
          if (disc) rows.push(disc);
        });
        body.appendChild(h('table', { class: 'data-table' }, [
          h('thead', null, h('tr', null, [
            h('th', null, 'Payer ID'),
            h('th', null, 'Member ID'),
            h('th', null, 'Primary'),
            h('th', null, 'OON rate'),
            h('th', { class: 'data-table__num' }, ''),
          ])),
          h('tbody', null, rows),
        ]));
      }

      paint(initialRecords || []);

      return h('div', { class: 'card' }, [
        h('div', { class: 'card__header' }, [
          h('h2', { class: 'card__title' }, 'Insurance'),
          h('button', { class: 'btn btn--ghost btn--sm', type: 'button',
            onClick: function () { openForm(null); } }, 'Add insurance'),
        ]),
        body,
      ]);
    }

    // --- Panel B: Sessions ---------------------------------------------------
    function sessionsPanel(client, initialSessions) {
      var body = h('div');

      function reload() {
        api.sessions.list({ client_id: id }).then(function (res) {
          paint((res && res.sessions) || []);
        }).catch(function (err) {
          R.clear(body);
          body.appendChild(inlineEmpty(err.message || 'Could not load sessions.'));
        });
      }

      function openForm(session) {
        // Load the clinician roster first; the picker options are dynamic, so the
        // clinician_id field is built at call time rather than as a constant.
        // Fetch ALL active users (not just role 'clinician'): the backend accepts
        // any active practice member as a session's clinician, and solo-practice
        // owners are role practice_admin — a role filter would return an empty roster.
        api.users.list({ active: true }).then(function (res) {
          var clinicians = (res && res.users) || [];
          var clinicianOptions = clinicians.map(function (u) {
            var label = ((u.first_name || '') + ' ' + (u.last_name || '')).trim()
              || u.email || ('User ' + u.id);
            return { value: u.id, label: label };
          });

          // Guard the empty case: never open a form whose required clinician_id
          // select has no options (session creation would fail silently).
          if (clinicianOptions.length === 0) {
            R.toast('No active clinicians in this practice', 'error');
            return;
          }

          // Preselect: client's primary clinician (if in the roster), else the
          // current user, else the first option.
          var inList = function (uid) {
            return clinicianOptions.some(function (o) { return o.value === uid; });
          };
          var cu = R.currentUser;
          var currentUserId = cu && cu.user && cu.user.id;
          var defaultClinicianId =
            (client.primary_clinician_id && inList(client.primary_clinician_id)
              ? client.primary_clinician_id : null) ||
            currentUserId ||
            (clinicianOptions[0] && clinicianOptions[0].value) ||
            '';

          var sessionFields = SESSION_FIELDS.concat([
            { name: 'clinician_id', label: 'Clinician', type: 'select',
              required: true, options: clinicianOptions },
          ]);

          // Recurrence is only offered when creating. "Repeat until" appears only
          // once a repeating cadence is chosen (formModal showIf) and is required
          // then; capped 6 months out.
          if (!session) {
            sessionFields = sessionFields.concat([
              { name: 'repeats', label: 'Repeats', type: 'select',
                options: RECURRENCE_OPTIONS },
              { name: 'recurrence_end_date', label: 'Repeat until', type: 'date',
                required: true, max: sixMonthsOut(),
                showIf: function (v) { return v.repeats && v.repeats !== 'none'; } },
            ]);
          }

          var values = { clinician_id: defaultClinicianId };
          if (session) {
            // Editing: carry the session's own values (diagnosis_codes stays an
            // array — the diagnosis picker accepts arrays directly).
            Object.keys(session).forEach(function (k) { values[k] = session[k]; });
          } else {
            values.repeats = 'none';
            // Auto-populate the diagnosis from the client's default code(s); the
            // picker still lets the clinician override per session.
            values.diagnosis_codes = Array.isArray(client.diagnosis_codes)
              ? client.diagnosis_codes.slice()
              : [];
          }

          R.formModal({
            title: session ? 'Edit session' : 'Add session',
            fields: sessionFields,
            values: values,
            submitLabel: session ? 'Save changes' : 'Add session',
          }).then(function (result) {
            if (!result) return;

            var codes = (result.diagnosis_codes || '')
              .split(',').map(function (s) { return s.trim(); })
              .filter(Boolean);

            var payload = compact(result);
            delete payload.diagnosis_codes;
            delete payload.repeats;              // form-only fields; mapped below
            delete payload.recurrence_end_date;
            if (codes.length) payload.diagnosis_codes = codes;
            payload.clinician_id = result.clinician_id;

            // Recurrence (create only): map the form's cadence to the API params.
            if (!session && result.repeats && result.repeats !== 'none') {
              payload.recurrence = result.repeats;
              payload.recurrence_end_date = result.recurrence_end_date;
            }

            if (session) {
              // client_id is immutable on a session — the PATCH endpoint rejects
              // any body that carries it (400), so an edit must never send it.
              api.sessions.update(session.id, payload).then(function (res) {
                // Completing a session auto-drafts a claim server-side.
                if (res && res.claim_created) {
                  R.toast('Draft claim created — review in Claims.', 'success');
                } else {
                  R.toast('Session updated', 'success');
                }
                reload();
              }).catch(function (err) {
                R.toast(err.message, 'error');
              });
            } else {
              // Create attaches the session to this client.
              payload.client_id = id;
              api.sessions.create(payload).then(function (res) {
                if (res && res.count && res.count > 1) {
                  R.toast(res.count + ' sessions scheduled', 'success');
                } else {
                  R.toast('Session added', 'success');
                }
                reload();
              }).catch(function (err) {
                R.toast(err.message, 'error');
              });
            }
          });
        }).catch(function (err) {
          R.toast(err.message || 'Could not load clinicians', 'error');
        });
      }

      function openDeleteSession(session) {
        R.confirmModal({
          title: 'Delete session?',
          body: 'This hides the session record.',
          confirmLabel: 'Delete',
          danger: true,
        }).then(function (ok) {
          if (!ok) return;
          api.sessions.remove(session.id).then(function () {
            R.toast('Session deleted', 'success');
            reload();
          }).catch(function (err) {
            R.toast(err.message, 'error');
          });
        });
      }

      function paint(sessions) {
        R.clear(body);
        if (!sessions.length) {
          body.appendChild(inlineEmpty('No sessions yet'));
          return;
        }
        var rows = sessions.map(function (s) {
          return h('tr', null, [
            h('td', null, R.fmtDate(s.session_date)),
            h('td', null, s.cpt_code || '—'),
            h('td', { class: 'data-table__num' }, R.fmtMoney(s.fee)),
            h('td', null, R.statusBadge(s.status)),
            rowActions(
              function () { openForm(s); },
              function () { openDeleteSession(s); }
            ),
          ]);
        });
        body.appendChild(h('table', { class: 'data-table' }, [
          h('thead', null, h('tr', null, [
            h('th', null, 'Date'),
            h('th', null, 'CPT'),
            h('th', { class: 'data-table__num' }, 'Fee'),
            h('th', null, 'Status'),
            h('th', { class: 'data-table__num' }, ''),
          ])),
          h('tbody', null, rows),
        ]));
      }

      paint(initialSessions || []);

      return h('div', { class: 'card' }, [
        h('div', { class: 'card__header' }, [
          h('h2', { class: 'card__title' }, 'Sessions'),
          h('button', { class: 'btn btn--ghost btn--sm', type: 'button',
            onClick: function () { openForm(null); } }, 'Add session'),
        ]),
        body,
      ]);
    }

    // --- Compose the detail view --------------------------------------------
    function render(client, insurance, sessions) {
      R.clear(root);

      var view = h('div', { class: 'view stack' }, [
        backLink(),
        headerCard(client, insurance),
        insurancePanel(client, insurance),
        sessionsPanel(client, sessions),
      ]);

      root.appendChild(view);
    }

    load();
  }

  // ===========================================================================
  // Route registration — params[0] is the client id when present.
  // ===========================================================================
  R.registerView('clients', function (root, params) {
    if (params && params[0]) return renderClientDetail(root, params[0]);
    return renderClientList(root);
  });
})(window, document);
