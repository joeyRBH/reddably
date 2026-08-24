/* =============================================================================
 * Reddably — hash router + shared view toolkit (window.Reddably)
 * =============================================================================
 * Loads AFTER api-client.js and app.js. Owns hash routing and the shared
 * helpers every view (clients / sessions / claims / dashboard) consumes.
 *
 * All network calls go through window.ReddablyAPI — this module never calls
 * fetch() directly. No PHI in hashes/URLs (ids and status enums only).
 *
 * Public surface (prompts 06-07 depend on these exact signatures):
 *   Reddably.api, Reddably.routes, registerView, navigate,
 *   h, clear, renderLoading, renderError, renderEmpty,
 *   toast, confirmModal, formModal,
 *   fmtMoney, fmtDate, statusBadge
 * ========================================================================== */
(function (window, document) {
  'use strict';

  var api = window.ReddablyAPI;
  var routes = {};

  // ---------------------------------------------------------------------------
  // DOM builder
  // ---------------------------------------------------------------------------
  // h(tag, attrs, children) -> Element.
  //   attrs: { class, html, onClick, onSubmit, ...any attribute/property }.
  //   children: a node, a string, or an array of either (null/undefined skipped).
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var val = attrs[key];
        if (val === null || val === undefined || val === false) return;
        if (key === 'class' || key === 'className') {
          el.className = val;
        } else if (key === 'html' || key === 'innerHTML') {
          el.innerHTML = val;
        } else if (key === 'text' || key === 'textContent') {
          el.textContent = val;
        } else if (key === 'dataset' && typeof val === 'object') {
          Object.keys(val).forEach(function (d) { el.dataset[d] = val[d]; });
        } else if (key.indexOf('on') === 0 && typeof val === 'function') {
          el.addEventListener(key.slice(2).toLowerCase(), val);
        } else {
          el.setAttribute(key, val);
        }
      });
    }
    appendChildren(el, children);
    return el;
  }

  function appendChildren(el, children) {
    if (children === null || children === undefined || children === false) return;
    if (Array.isArray(children)) {
      children.forEach(function (c) { appendChildren(el, c); });
      return;
    }
    if (children.nodeType) {
      el.appendChild(children);
    } else {
      el.appendChild(document.createTextNode(String(children)));
    }
  }

  function clear(el) {
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  // ---------------------------------------------------------------------------
  // Loading / error / empty states
  // ---------------------------------------------------------------------------
  function renderLoading(root) {
    clear(root);
    var panel = h('div', { class: 'view stack' }, [
      h('div', { class: 'skeleton skeleton--title' }),
      h('div', { class: 'card' }, [
        h('div', { class: 'skeleton skeleton--line' }),
        h('div', { class: 'skeleton skeleton--line' }),
        h('div', { class: 'skeleton skeleton--line', style: 'width:70%' }),
      ]),
    ]);
    root.appendChild(panel);
  }

  function renderError(root, err, retryFn) {
    clear(root);
    var msg = (err && err.message) || 'Something went wrong.';
    var children = [
      h('svg', {
        class: 'empty-state__icon',
        viewBox: '0 0 24 24',
        'aria-hidden': 'true',
        html: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
              '<path d="M12 7v6M12 16.5v.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
      }),
      h('h1', { class: 'empty-state__title' }, 'Could not load this view'),
      h('p', { class: 'empty-state__body' }, msg),
    ];
    if (typeof retryFn === 'function') {
      children.push(
        h('button', { class: 'btn btn--primary', onClick: retryFn }, 'Retry')
      );
    }
    root.appendChild(h('div', { class: 'empty-state' }, children));
  }

  // renderEmpty(root, { title, body, actionLabel, onAction })
  function renderEmpty(root, opts) {
    clear(root);
    opts = opts || {};
    var children = [
      h('svg', {
        class: 'empty-state__icon',
        viewBox: '0 0 24 24',
        'aria-hidden': 'true',
        html: '<rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
              '<path d="M3 9h18M8 14h8M8 17h5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
      }),
      h('h1', { class: 'empty-state__title' }, opts.title || 'Nothing here yet'),
      h('p', { class: 'empty-state__body' }, opts.body || ''),
    ];
    if (opts.actionLabel && typeof opts.onAction === 'function') {
      children.push(
        h('button', { class: 'btn btn--primary', onClick: opts.onAction }, opts.actionLabel)
      );
    }
    root.appendChild(h('div', { class: 'empty-state' }, children));
  }

  // ---------------------------------------------------------------------------
  // Toasts
  // ---------------------------------------------------------------------------
  function toastHost() {
    var host = document.getElementById('toast-host');
    if (!host) {
      host = h('div', { class: 'toast-host', id: 'toast-host' });
      document.body.appendChild(host);
    }
    return host;
  }

  // toast(message, kind, durationMs)
  //   kind: 'success' | 'error' | 'warn' | undefined (neutral)
  //   durationMs: how long before it auto-dismisses (default 4s). Pass a longer dwell
  //     for a message the user must not miss — a warning that something needs manual
  //     follow-up is useless if it disappears before it is read.
  var TOAST_DEFAULT_MS = 4000;

  function toast(message, kind, durationMs) {
    var host = toastHost();
    var modifier = kind === 'success' ? ' toast--success'
      : kind === 'error' ? ' toast--error'
      : kind === 'warn' ? ' toast--warn'
      : '';
    var el = h('div', { class: 'toast' + modifier, role: 'status', 'aria-live': 'polite' }, message);
    host.appendChild(el);

    var removed = false;
    function remove() {
      if (removed) return;
      removed = true;
      el.classList.add('is-leaving');
      window.setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 250);
    }
    el.addEventListener('click', remove);
    window.setTimeout(remove, durationMs || TOAST_DEFAULT_MS);
  }

  // ---------------------------------------------------------------------------
  // Modal core (shared by confirmModal + formModal)
  // ---------------------------------------------------------------------------
  // openModal({ title, bodyNode, footerNodes, onClose }) -> { close }.
  function openModal(opts) {
    var previousFocus = document.activeElement;

    var panel = h('div', {
      class: 'modal__panel',
      role: 'dialog',
      'aria-modal': 'true',
    }, [
      h('div', { class: 'modal__header' }, [
        h('h2', { class: 'modal__title' }, opts.title || ''),
      ]),
      h('div', { class: 'modal__body' }, opts.bodyNode || null),
      h('div', { class: 'modal__footer' }, opts.footerNodes || null),
    ]);

    var backdrop = h('div', { class: 'modal__backdrop' }, panel);

    function close() {
      document.removeEventListener('keydown', onKeydown);
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      if (previousFocus && previousFocus.focus) {
        try { previousFocus.focus(); } catch (e) { /* ignore */ }
      }
    }

    function onKeydown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (typeof opts.onClose === 'function') opts.onClose();
      }
    }

    backdrop.addEventListener('mousedown', function (e) {
      if (e.target === backdrop && typeof opts.onClose === 'function') opts.onClose();
    });
    document.addEventListener('keydown', onKeydown);

    document.body.appendChild(backdrop);

    // Focus the first focusable control in the panel.
    var focusable = panel.querySelector(
      'input, select, textarea, button, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable && focusable.focus) {
      try { focusable.focus(); } catch (e) { /* ignore */ }
    }

    return { close: close, panel: panel };
  }

  // confirmModal({ title, body, confirmLabel, danger }) -> Promise<boolean>
  function confirmModal(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var settled = false;
      function settle(val, modal) {
        if (settled) return;
        settled = true;
        modal.close();
        resolve(val);
      }

      var cancelBtn = h('button', { class: 'btn btn--ghost', type: 'button' },
        opts.cancelLabel || 'Cancel');
      var confirmBtn = h('button', {
        class: 'btn ' + (opts.danger ? 'btn--danger' : 'btn--primary'),
        type: 'button',
      }, opts.confirmLabel || 'Confirm');

      var body = typeof opts.body === 'string'
        ? h('p', { style: 'margin:0' }, opts.body)
        : (opts.body || null);

      var modal = openModal({
        title: opts.title || 'Are you sure?',
        bodyNode: body,
        footerNodes: [cancelBtn, confirmBtn],
        onClose: function () { settle(false, modal); },
      });

      cancelBtn.addEventListener('click', function () { settle(false, modal); });
      confirmBtn.addEventListener('click', function () { settle(true, modal); });
    });
  }

  // ---------------------------------------------------------------------------
  // Payer type-ahead picker — reusable across the Verify Benefits + insurance
  // forms. A visible search box calls the payer-search API (debounced 300ms) and
  // lists "Name — PAYERID" matches beneath it; selecting one fills a hidden
  // control with the payer_id while showing the chosen name. Typing a raw payer
  // id and submitting without selecting still works — the hidden control mirrors
  // the raw text on every keystroke. Responses for a superseded query are ignored.
  //
  // Returns { node, control } where `node` is the composite element to render and
  // `control` is a hidden <input> whose .value is the payer_id to submit, so the
  // existing formModal collect()/required-validation path works unchanged.
  function createPayerPicker(opts) {
    opts = opts || {};
    var initial = opts.initial || '';

    var hidden = h('input', { type: 'hidden', name: opts.name || 'payer_id', value: initial });
    var input = h('input', {
      class: 'field__control',
      type: 'text',
      autocomplete: 'off',
      spellcheck: 'false',
      value: initial,
      placeholder: opts.placeholder || 'Search payer name or enter a Payer ID…',
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': 'false',
    });
    var results = h('div', { class: 'payer-picker__results', role: 'listbox', hidden: 'hidden' });
    var node = h('div', { class: 'payer-picker' }, [input, results, hidden]);

    var seq = 0;            // id of the most recently issued request (stale-guard)
    var timer = null;
    var currentList = [];
    var activeIndex = -1;

    function openResults() {
      results.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }
    function closeResults() {
      results.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      activeIndex = -1;
    }

    function showStatus(text) {
      clear(results);
      results.appendChild(h('div', { class: 'payer-picker__status' }, text));
      openResults();
    }

    function paintActive() {
      var optionEls = results.querySelectorAll('.payer-picker__option');
      Array.prototype.forEach.call(optionEls, function (el, i) {
        el.classList.toggle('is-active', i === activeIndex);
      });
      if (activeIndex >= 0 && optionEls[activeIndex]) {
        optionEls[activeIndex].scrollIntoView({ block: 'nearest' });
      }
    }

    function choose(p) {
      if (!p) return;
      hidden.value = p.payer_id;
      // Stash the chosen payer's display name so the form can persist it
      // alongside the payer_id (collect() reads data-payer-name). Cleared on any
      // raw keystroke below, so it only survives an explicit pick.
      if (p.name) hidden.setAttribute('data-payer-name', p.name);
      else hidden.removeAttribute('data-payer-name');
      input.value = p.name ? (p.name + ' (' + p.payer_id + ')') : p.payer_id;
      closeResults();
    }

    function renderResults(list) {
      currentList = list || [];
      activeIndex = -1;
      clear(results);
      if (!currentList.length) {
        results.appendChild(h('div', { class: 'payer-picker__status' }, 'No payers found'));
        openResults();
        return;
      }
      currentList.forEach(function (p, i) {
        var opt = h('div', { class: 'payer-picker__option', role: 'option' }, [
          h('span', { class: 'payer-picker__option-name' }, p.name || '(unnamed payer)'),
          h('span', { class: 'payer-picker__option-id' }, p.payer_id),
        ]);
        // mousedown (not click) so the pick runs before the input's blur fires.
        opt.addEventListener('mousedown', function (e) {
          e.preventDefault();
          choose(currentList[i]);
        });
        opt.addEventListener('mouseenter', function () { activeIndex = i; paintActive(); });
        results.appendChild(opt);
      });
      openResults();
    }

    function runSearch(q) {
      var mySeq = ++seq;
      showStatus('Searching…');
      api.payers.search(q).then(function (res) {
        if (mySeq !== seq) return;   // a newer query superseded this response
        renderResults((res && res.payers) || []);
      }).catch(function (err) {
        if (mySeq !== seq) return;   // stale error — ignore
        closeResults();
        toast((err && err.message) || 'Payer search failed', 'error');
      });
    }

    input.addEventListener('input', function () {
      var q = input.value.trim();
      hidden.value = q;              // raw passthrough: submit whatever is typed
      hidden.removeAttribute('data-payer-name');  // raw text is an id, not a name
      if (timer) { window.clearTimeout(timer); timer = null; }
      if (q.length < 2) { seq++; closeResults(); return; }  // too short: invalidate + hide
      timer = window.setTimeout(function () { runSearch(q); }, 300);
    });

    input.addEventListener('keydown', function (e) {
      if (results.hidden) return;
      var optionEls = results.querySelectorAll('.payer-picker__option');
      if (e.key === 'ArrowDown') {
        if (!optionEls.length) return;
        e.preventDefault();
        activeIndex = Math.min(optionEls.length - 1, activeIndex + 1);
        paintActive();
      } else if (e.key === 'ArrowUp') {
        if (!optionEls.length) return;
        e.preventDefault();
        activeIndex = Math.max(0, activeIndex - 1);
        paintActive();
      } else if (e.key === 'Enter') {
        // Only intercept Enter to pick a highlighted option; otherwise let the
        // form submit with whatever raw value is present.
        if (activeIndex >= 0 && activeIndex < currentList.length) {
          e.preventDefault();
          choose(currentList[activeIndex]);
        }
      } else if (e.key === 'Escape') {
        // Close the dropdown without closing the modal.
        e.stopPropagation();
        closeResults();
      }
    });

    // Hide the list when focus leaves, after a tick so an option mousedown lands.
    input.addEventListener('blur', function () {
      window.setTimeout(closeResults, 150);
    });

    return { node: node, control: hidden };
  }

  // ---------------------------------------------------------------------------
  // Diagnosis picker — a multi-select, searchable ICD-10 picker backed by the
  // curated billable list (window.ReddablyDiagnoses). Only codes in that list can
  // be added, so a category code (e.g. F10.9) that Aetna rejects can never be
  // chosen — only its billable children (F10.90). Codes carried in on `initial`
  // that predate the picker are preserved as chips even if not in the list, so an
  // edit never silently drops stored data.
  //
  // Returns { node, control } where `control` is a hidden <input> whose .value is
  // the comma-joined DOTLESS codes (as transmitted in the 837P) — so formModal's
  // collect() path works unchanged and the view splits on comma.
  function createDiagnosisPicker(opts) {
    opts = opts || {};
    var D = window.ReddablyDiagnoses;

    // Accept an array or a comma string; normalize + de-dupe into dotless codes.
    var raw = opts.initial;
    var initialCodes = [];
    (Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(','))
      .forEach(function (c) {
        var code = D ? D.normalize(c) : String(c || '').trim().toUpperCase();
        if (code && initialCodes.indexOf(code) === -1) initialCodes.push(code);
      });

    var selected = initialCodes.slice();

    var hidden = h('input', { type: 'hidden', name: opts.name || 'diagnosis_codes' });
    var chips = h('div', {
      class: 'dx-picker__chips',
      style: 'display:flex;flex-wrap:wrap;gap:var(--space-2);'
        + 'margin-bottom:var(--space-2)',
    });
    var input = h('input', {
      class: 'field__control',
      type: 'text',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: opts.placeholder || 'Search code or condition (e.g. F411 or anxiety)…',
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': 'false',
    });
    var results = h('div', { class: 'payer-picker__results', role: 'listbox', hidden: 'hidden' });
    var picker = h('div', { class: 'payer-picker' }, [input, results, hidden]);
    var node = h('div', { class: 'dx-picker' }, [chips, picker]);

    var currentList = [];
    var activeIndex = -1;

    function syncControl() { hidden.value = selected.join(','); }

    function codeText(code) {
      return D ? D.label(code) : code;
    }

    function renderChips() {
      clear(chips);
      if (!selected.length) {
        chips.appendChild(h('span', {
          class: 'dx-picker__empty',
          style: 'color:var(--color-text-muted);font-size:var(--font-size-2)',
        }, 'No diagnosis codes selected'));
        return;
      }
      selected.forEach(function (code) {
        var chip = h('span', {
          class: 'badge badge--neutral',
          style: 'display:inline-flex;align-items:center;gap:var(--space-1)',
          title: codeText(code),
        }, [
          D ? D.display(code) : code,
          h('button', {
            type: 'button',
            'aria-label': 'Remove ' + (D ? D.display(code) : code),
            style: 'background:none;border:none;cursor:pointer;padding:0;'
              + 'font-size:var(--font-size-3);line-height:1;color:inherit',
            onClick: function () { removeCode(code); },
          }, '×'),
        ]);
        chips.appendChild(chip);
      });
    }

    function openResults() { results.hidden = false; input.setAttribute('aria-expanded', 'true'); }
    function closeResults() { results.hidden = true; input.setAttribute('aria-expanded', 'false'); activeIndex = -1; }

    function addCode(code) {
      var norm = D ? D.normalize(code) : String(code || '').trim().toUpperCase();
      if (!norm) return;
      if (selected.indexOf(norm) === -1) {
        selected.push(norm);
        syncControl();
        renderChips();
      }
      input.value = '';
      closeResults();
    }

    function removeCode(code) {
      selected = selected.filter(function (c) { return c !== code; });
      syncControl();
      renderChips();
    }

    function paintActive() {
      var optionEls = results.querySelectorAll('.payer-picker__option');
      Array.prototype.forEach.call(optionEls, function (el, i) {
        el.classList.toggle('is-active', i === activeIndex);
      });
      if (activeIndex >= 0 && optionEls[activeIndex]) {
        optionEls[activeIndex].scrollIntoView({ block: 'nearest' });
      }
    }

    function renderResults(list) {
      currentList = list || [];
      activeIndex = -1;
      clear(results);
      if (!currentList.length) {
        results.appendChild(h('div', { class: 'payer-picker__status' }, 'No billable codes match'));
        openResults();
        return;
      }
      currentList.forEach(function (entry, i) {
        var opt = h('div', { class: 'payer-picker__option', role: 'option' }, [
          h('span', { class: 'payer-picker__option-name' }, entry.label),
          h('span', { class: 'payer-picker__option-id' }, D ? D.display(entry.code) : entry.code),
        ]);
        opt.addEventListener('mousedown', function (e) {
          e.preventDefault();
          addCode(currentList[i].code);
        });
        opt.addEventListener('mouseenter', function () { activeIndex = i; paintActive(); });
        results.appendChild(opt);
      });
      openResults();
    }

    input.addEventListener('input', function () {
      if (!D) { closeResults(); return; }
      var q = input.value.trim();
      renderResults(D.search(q, 8));
    });

    input.addEventListener('focus', function () {
      if (!D) return;
      renderResults(D.search(input.value.trim(), 8));
    });

    input.addEventListener('keydown', function (e) {
      if (results.hidden) {
        // Enter on a raw exact billable code adds it even without opening the list.
        if (e.key === 'Enter' && D && D.isBillableCode(input.value)) {
          e.preventDefault();
          addCode(input.value);
        }
        return;
      }
      var optionEls = results.querySelectorAll('.payer-picker__option');
      if (e.key === 'ArrowDown') {
        if (!optionEls.length) return;
        e.preventDefault();
        activeIndex = Math.min(optionEls.length - 1, activeIndex + 1);
        paintActive();
      } else if (e.key === 'ArrowUp') {
        if (!optionEls.length) return;
        e.preventDefault();
        activeIndex = Math.max(0, activeIndex - 1);
        paintActive();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeIndex >= 0 && activeIndex < currentList.length) {
          addCode(currentList[activeIndex].code);
        } else if (D && D.isBillableCode(input.value)) {
          addCode(input.value);
        }
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        closeResults();
      }
    });

    input.addEventListener('blur', function () { window.setTimeout(closeResults, 150); });

    syncControl();
    renderChips();

    return { node: node, control: hidden };
  }

  // formModal({ title, fields, values, submitLabel, cancelLabel }) -> Promise<values|null>
  //   fields: [{ name, label, type, required, options, placeholder }]
  //   types: text | email | date | number | select | textarea | payer (default text)
  function formModal(opts) {
    opts = opts || {};
    var fields = opts.fields || [];
    var values = opts.values || {};

    return new Promise(function (resolve) {
      var settled = false;
      function settle(val, modal) {
        if (settled) return;
        settled = true;
        modal.close();
        resolve(val);
      }

      var controls = {};      // name -> control element
      var fieldEls = {};      // name -> .field wrapper (for error toggling)
      var errorEls = {};      // name -> .field__error element

      var form = h('form', { novalidate: 'novalidate' });

      fields.forEach(function (f) {
        var type = f.type || 'text';
        var initial = values[f.name];
        if (initial === null || initial === undefined) initial = '';

        var control;
        var display;   // node rendered in the field (usually the control itself)
        if (type === 'select') {
          control = h('select', { class: 'field__control', name: f.name },
            (f.options || []).map(function (opt) {
              var value = (opt && typeof opt === 'object') ? opt.value : opt;
              var label = (opt && typeof opt === 'object') ? opt.label : opt;
              var attrs = { value: value };
              if (String(value) === String(initial)) attrs.selected = 'selected';
              return h('option', attrs, label);
            })
          );
          display = control;
        } else if (type === 'textarea') {
          control = h('textarea', {
            class: 'field__control',
            name: f.name,
            placeholder: f.placeholder || '',
          }, String(initial));
          display = control;
        } else if (type === 'payer') {
          var picker = createPayerPicker({
            name: f.name,
            initial: String(initial),
            placeholder: f.placeholder,
          });
          control = picker.control;   // hidden input carrying the payer_id
          display = picker.node;      // composite search box + results list
        } else if (type === 'diagnosis') {
          // `initial` may be an array (client/session.diagnosis_codes) or a
          // comma string; the picker normalizes either. control.value is the
          // comma-joined dotless codes.
          var dxPicker = createDiagnosisPicker({
            name: f.name,
            initial: values[f.name],
            placeholder: f.placeholder,
          });
          control = dxPicker.control;
          display = dxPicker.node;
        } else if (type === 'checkbox') {
          // A boolean toggle. Optionally UI-only (uiOnly): a convenience control
          // like "same as patient" that copies values into other fields via
          // onToggle and is never itself collected into the submitted payload.
          control = h('input', { class: 'field__checkbox', type: 'checkbox', name: f.name });
          if (initial === true || initial === 'true') control.checked = true;
          display = control;
        } else {
          control = h('input', {
            class: 'field__control',
            type: type,
            name: f.name,
            value: String(initial),
            placeholder: f.placeholder || '',
          });
          if (f.min != null) control.setAttribute('min', String(f.min));
          if (f.max != null) control.setAttribute('max', String(f.max));
          display = control;
        }

        controls[f.name] = control;

        var errorEl = h('span', { class: 'field__error', hidden: 'hidden' });
        errorEls[f.name] = errorEl;

        var labelText = f.label || f.name;
        var hintNode = f.hint
          ? h('p', {
            class: 'field__hint',
            style: 'margin:var(--space-1) 0 0;color:var(--color-text-muted);' +
              'font-size:var(--font-size-2)',
          }, f.hint)
          : null;

        var fieldEl;
        if (type === 'checkbox') {
          // Checkbox row: box first, then the label text inline beside it.
          var checkRow = h('span', {
            style: 'display:flex;align-items:center;gap:var(--space-2)',
          }, [display, h('span', { class: 'field__label' }, labelText)]);
          var checkChildren = [checkRow];
          if (hintNode) checkChildren.push(hintNode);
          checkChildren.push(errorEl);
          fieldEl = h('label', { class: 'field field--checkbox' }, checkChildren);
        } else {
          var labelChildren = [
            h('span', { class: 'field__label' },
              f.required ? [labelText, ' ', h('span', { 'aria-hidden': 'true' }, '*')] : labelText),
            display,
          ];
          // Optional persistent helper copy under the control (e.g. how an optional
          // field is formatted). Muted, small; distinct from the validation error.
          if (hintNode) labelChildren.push(hintNode);
          labelChildren.push(errorEl);
          fieldEl = h('label', { class: 'field' }, labelChildren);
        }
        fieldEls[f.name] = fieldEl;
        form.appendChild(fieldEl);
      });

      // Wire checkbox convenience toggles: a field may declare onToggle(checked,
      // controls) to copy values into (or clear) other fields when it is ticked.
      // Additive — no existing field uses this, so ordinary forms are unaffected.
      fields.forEach(function (f) {
        if (f.type === 'checkbox' && typeof f.onToggle === 'function') {
          controls[f.name].addEventListener('change', function () {
            f.onToggle(controls[f.name].checked, controls);
          });
        }
      });

      // Conditional visibility: a field may declare showIf(values) -> boolean.
      // Re-evaluated on every input/change. Hidden fields skip required-validation
      // and are collected as null so a stale value never reaches the API.
      function currentValues() {
        var snap = {};
        fields.forEach(function (f) { snap[f.name] = controls[f.name].value; });
        return snap;
      }
      function isHidden(name) {
        return fieldEls[name] && fieldEls[name].hidden === true;
      }
      function applyVisibility() {
        var snap = currentValues();
        fields.forEach(function (f) {
          if (typeof f.showIf === 'function') {
            fieldEls[f.name].hidden = !f.showIf(snap);
          }
        });
      }

      function setError(name, message) {
        var errEl = errorEls[name];
        var fieldEl = fieldEls[name];
        if (message) {
          errEl.textContent = message;
          errEl.hidden = false;
          fieldEl.classList.add('field--invalid');
        } else {
          errEl.textContent = '';
          errEl.hidden = true;
          fieldEl.classList.remove('field--invalid');
        }
      }

      function collect() {
        var out = {};
        var ok = true;
        fields.forEach(function (f) {
          // UI-only controls (e.g. a "same as patient" checkbox) drive other
          // fields but are never part of the submitted payload.
          if (f.uiOnly) return;
          if (isHidden(f.name)) {
            setError(f.name, null);
            out[f.name] = null;
            return;
          }
          var raw = controls[f.name].value;
          var val = typeof raw === 'string' ? raw.trim() : raw;
          if (f.required && (val === '' || val === null || val === undefined)) {
            setError(f.name, (f.label || f.name) + ' is required.');
            ok = false;
            out[f.name] = null;
            return;
          }
          // Optional per-field validation (only when a value is present). A
          // validate(value) that returns a string is treated as an inline error
          // message; returning null/undefined passes. transform(value) lets a
          // field rewrite its collected value (e.g. normalize a phone to E.164).
          if (val !== '' && val != null && typeof f.validate === 'function') {
            var msg = f.validate(val);
            if (msg) {
              setError(f.name, msg);
              ok = false;
              out[f.name] = val;
              return;
            }
          }
          setError(f.name, null);
          if (val !== '' && val != null && typeof f.transform === 'function') {
            val = f.transform(val);
          }
          out[f.name] = val === '' ? null : val;
          // A payer field can persist the selected payer's display name under a
          // companion key (e.g. carrier_name). Only emitted when the user picked
          // a payer from the dropdown — omitted for raw-typed ids or an untouched
          // edit, so a stored carrier_name is never blanked out.
          if (f.type === 'payer' && f.payerNameField) {
            var payerName = controls[f.name].getAttribute('data-payer-name');
            if (payerName) out[f.payerNameField] = payerName;
          }
        });
        return ok ? out : null;
      }

      // cancelLabel mirrors confirmModal's existing option. It matters for a
      // form that is one skippable step of a chain: 'Cancel' there reads as
      // undoing what came before, when it only means 'not now'.
      var cancelBtn = h('button', { class: 'btn btn--ghost', type: 'button' },
        opts.cancelLabel || 'Cancel');
      var submitBtn = h('button', { class: 'btn btn--primary', type: 'submit' },
        opts.submitLabel || 'Save');

      function onSubmit(e) {
        if (e) e.preventDefault();
        var result = collect();
        if (result === null) return;       // validation failed; errors are shown
        settle(result, modal);
      }

      form.addEventListener('submit', onSubmit);
      form.addEventListener('input', applyVisibility);
      form.addEventListener('change', applyVisibility);
      applyVisibility();   // set initial hidden state before first paint

      var modal = openModal({
        title: opts.title || 'Form',
        bodyNode: form,
        footerNodes: [cancelBtn, submitBtn],
        onClose: function () { settle(null, modal); },
      });

      cancelBtn.addEventListener('click', function () { settle(null, modal); });
      submitBtn.addEventListener('click', onSubmit);
    });
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------
  function fmtMoney(n) {
    if (n === null || n === undefined || n === '') return '—';
    var num = typeof n === 'number' ? n : parseFloat(n);
    if (isNaN(num)) return '—';
    return '$' + num.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function fmtDate(s) {
    if (!s) return '—';
    var d;
    // Date-only strings ("2026-06-01") are parsed as local to avoid TZ drift.
    if (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)) {
      var p = s.split('-');
      d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    } else {
      d = new Date(s);
    }
    if (isNaN(d.getTime())) return '—';
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }

  // ---------------------------------------------------------------------------
  // White-label scrub — the clearinghouse vendor must be invisible to app users.
  // Any text that originates from the clearinghouse (e.g. an enrollment's manual-
  // step instructions) is passed through this before it is rendered: the vendor
  // name is replaced with a generic phrase, and any vendor URL is replaced with a
  // "see your enrollment contact" pointer (never a clickable link to their site).
  // Case-insensitive; null-safe (returns '' for nullish input).
  // ---------------------------------------------------------------------------
  function scrubVendor(text) {
    if (text == null) return '';
    var s = String(text);
    // Strip vendor URLs first (before the bare-word pass would mangle the host).
    s = s.replace(/https?:\/\/\S*stedi\.com\S*/gi, '(see your enrollment contact)');
    s = s.replace(/\bstedi\.com\b/gi, '(see your enrollment contact)');
    // Then the bare brand name anywhere it appears.
    s = s.replace(/stedi/gi, 'the clearinghouse');
    return s;
  }

  // ---------------------------------------------------------------------------
  // Status badge — tone mapping shared across sessions / claims / clients.
  // ---------------------------------------------------------------------------
  var BADGE_TONES = {
    // neutral
    draft: 'neutral', scheduled: 'neutral', void: 'neutral',
    no_claim: 'neutral', completed: 'neutral',
    // info — in-flight only: the payer/clearinghouse has not committed yet.
    processing: 'info', claim_ready: 'info',
    // warning
    info_requested: 'warning', appealed: 'warning',
    awaiting_payment: 'warning', awaiting_info: 'warning',
    // success
    paid: 'success', active: 'success',
    // Externally committed: the claim left the practice and the clearinghouse
    // took it. Distinct from `processing`/`claim_ready`, which are still ours.
    submitted: 'success', claim_submitted: 'success',
    // danger
    denied: 'danger', inactive: 'danger',
  };

  function humanizeStatus(status) {
    if (!status) return '—';
    return String(status).replace(/_/g, ' ').replace(/\b\w/g, function (c) {
      return c.toUpperCase();
    });
  }

  function statusBadge(status) {
    var tone = BADGE_TONES[status] || 'neutral';
    return h('span', { class: 'badge badge--' + tone }, humanizeStatus(status));
  }

  // ---------------------------------------------------------------------------
  // Router
  // ---------------------------------------------------------------------------
  function registerView(hash, mountFn) {
    routes[hash] = mountFn;
  }

  function navigate(hash) {
    if (!hash) return;
    var clean = hash.charAt(0) === '#' ? hash.slice(1) : hash;
    window.location.hash = '#' + clean;
  }

  function parseHash() {
    var raw = window.location.hash || '#dashboard';
    if (raw.charAt(0) === '#') raw = raw.slice(1);
    if (!raw) raw = 'dashboard';
    var segments = raw.split('/').filter(function (s) { return s !== ''; });
    var route = segments.shift() || 'dashboard';
    return { route: route, params: segments };
  }

  // Update sidebar active state to match the current route.
  function syncNav(route) {
    var links = document.querySelectorAll('.nav-link');
    Array.prototype.forEach.call(links, function (link) {
      var href = link.getAttribute('href') || '';
      var linkHash = href.charAt(0) === '#' ? href.slice(1) : href;
      var linkRoute = linkHash.split('/')[0];
      var isActive = linkRoute === route;
      link.classList.toggle('is-active', isActive);
      if (isActive) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  function renderRoute() {
    var viewRoot = document.getElementById('view-root');
    if (!viewRoot) return;

    var parsed = parseHash();
    syncNav(parsed.route);
    clear(viewRoot);
    viewRoot.scrollTop = 0;

    var mount = routes[parsed.route];
    if (typeof mount === 'function') {
      try {
        mount(viewRoot, parsed.params);
      } catch (e) {
        renderError(viewRoot, e);
      }
    } else {
      renderEmpty(viewRoot, {
        title: 'Section coming soon',
        body: 'This part of Reddably is not built yet. Check back shortly.',
      });
    }
  }

  function initRouter() {
    window.addEventListener('hashchange', renderRoute);
    renderRoute();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initRouter);
  } else {
    initRouter();
  }

  // ---------------------------------------------------------------------------
  // Quick Start tutorial — clinician onboarding walkthrough
  // ---------------------------------------------------------------------------
  // Reuses openModal() for the a11y shell (focus restore, Escape + backdrop
  // dismissal) and mounts the whole walkthrough as one subtree in the modal
  // body. First-run auto-open is gated on a localStorage flag: the app has no
  // server-side per-user UI-preference store, so we follow the existing
  // reddably_* localStorage convention (same store as the auth token) rather
  // than inventing backend onboarding state. The reopen control ("View
  // tutorial" in the user menu) calls openTutorial() directly, ignoring the flag.
  var TUTORIAL_SEEN_KEY = 'reddably_tutorial_seen';

  function tutorialSeen() {
    try { return window.localStorage.getItem(TUTORIAL_SEEN_KEY) === '1'; }
    catch (e) { return false; }
  }
  function markTutorialSeen() {
    try { window.localStorage.setItem(TUTORIAL_SEEN_KEY, '1'); }
    catch (e) { /* storage disabled (private mode) — walkthrough just re-shows */ }
  }

  // Inline check glyph (injected as SVG markup so it renders in the SVG
  // namespace; h() builds HTML elements, which would not render a raw <svg>).
  var CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"'
    + ' fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"'
    + ' stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>';

  function tutCheck() { return h('span', { class: 'tutorial__check', html: CHECK_SVG }); }

  // Each demo card is illustrative only — no live controls (fake buttons/links
  // are non-interactive spans so they stay out of the focus order).
  var TUTORIAL_STEPS = [
    {
      badge: '01',
      eyebrow: 'Start with the essentials',
      title: 'Find your client’s contact details',
      body: 'Open the client’s chart and confirm their name and mobile number. '
        + 'That’s all you need to invite them.',
      callout: 'You stay focused on care—not paperwork.',
      demo: function () {
        return h('div', { class: 'tutorial__mini' }, [
          h('div', { class: 'tutorial__mini-row' }, [
            h('span', { class: 'tutorial__avatar' }, 'AM'),
            h('div', {}, [
              h('div', { class: 'tutorial__name' }, 'Alex Morgan'),
              h('div', { class: 'tutorial__meta' }, 'Client · (303) 555-0147'),
            ]),
          ]),
          h('div', { class: 'tutorial__mini-foot' }, [
            h('span', { class: 'tutorial__link' }, 'View chart'),
          ]),
        ]);
      },
    },
    {
      badge: '02',
      eyebrow: 'Send a secure invitation',
      title: 'Text one simple link',
      body: 'Send your client a secure link to add their insurance information and a '
        + 'payment method for claim submissions.',
      callout: 'Clients enter their own details, reducing back-and-forth and transcription errors.',
      demo: function () {
        return h('div', { class: 'tutorial__mini' }, [
          h('div', { class: 'tutorial__bubble' },
            'Hi Alex—use this secure link to add your insurance information for claims reimbursement.'),
          h('div', { class: 'tutorial__mini-foot' }, [
            h('span', { class: 'tutorial__meta' }, 'claims.sessionably.com/invite'),
            h('span', { class: 'tutorial__meta' }, 'Delivered'),
          ]),
        ]);
      },
    },
    {
      badge: '03',
      eyebrow: 'We’ll keep watch',
      title: 'Know when they’re ready',
      body: 'Sessionably Claims notifies you as soon as your client completes their '
        + 'information. No chasing forms or checking inboxes.',
      callout: 'You’ll know exactly when you can move forward.',
      demo: function () {
        return h('div', { class: 'tutorial__mini' }, [
          h('div', { class: 'tutorial__mini-row' }, [
            tutCheck(),
            h('div', {}, [
              h('div', { class: 'tutorial__name' }, 'Client information complete'),
              h('div', { class: 'tutorial__meta' }, 'Alex added insurance and payment details.'),
            ]),
          ]),
          h('div', { class: 'tutorial__mini-foot' }, [
            h('span', { class: 'tutorial__meta' }, 'Now'),
          ]),
        ]);
      },
    },
    {
      badge: '04',
      eyebrow: 'Keep the record current',
      title: 'Add sessions to their chart',
      body: 'Record completed sessions as you go. Sessionably Claims keeps the '
        + 'reimbursement workflow organized around the client.',
      callout: 'A few seconds now saves administrative time later.',
      demo: function () {
        function sessionRow(date) {
          return h('div', { class: 'tutorial__mini' }, [
            h('div', { class: 'tutorial__mini-row', style: 'justify-content:space-between' }, [
              h('div', { class: 'tutorial__mini-row' }, [
                tutCheck(),
                h('span', { class: 'tutorial__name' }, date + ' · 53 min'),
              ]),
              h('span', { class: 'tutorial__meta' }, 'Ready'),
            ]),
          ]);
        }
        return h('div', {}, [sessionRow('Jul 8'), sessionRow('Jul 15')]);
      },
    },
    {
      badge: '05',
      eyebrow: 'Turn care into reimbursement',
      title: 'Submit claims with confidence',
      body: 'Review the prepared claim, submit it, and track its progress—all '
        + 'without rebuilding the same information each time.',
      callout: 'Faster claims can mean faster reimbursement and less financial strain for clients.',
      demo: function () {
        return h('div', { class: 'tutorial__mini' }, [
          h('p', { class: 'tutorial__demo-label tutorial__demo-label--accent' }, 'Ready to submit'),
          h('div', { class: 'tutorial__amount' }, '2 sessions · $350.00'),
          h('span', { class: 'tutorial__fakebtn' }, 'Submit claims'),
        ]);
      },
    },
  ];

  // openTutorial() -> { close }. Builds the walkthrough once and re-renders the
  // per-step regions on Back/Next. The final step's primary action closes the
  // walkthrough and routes to Clients (the natural next task).
  function openTutorial() {
    var index = 0;
    var HEADING_ID = 'tutorial-heading';

    var badgeEl = h('span', { class: 'tutorial__badge' });
    var eyebrowEl = h('p', { class: 'tutorial__eyebrow' });
    var titleEl = h('h2', { class: 'tutorial__title', id: HEADING_ID });
    var ledeEl = h('p', { class: 'tutorial__lede' });
    var calloutTextEl = h('span');
    var calloutEl = h('div', { class: 'tutorial__callout' }, [
      h('span', { class: 'tutorial__callout-check', html: CHECK_SVG }),
      calloutTextEl,
    ]);
    var demoBodyEl = h('div');
    var copyCol = h('div', { class: 'tutorial__copy' }, [badgeEl, eyebrowEl, titleEl, ledeEl, calloutEl]);
    var demoCol = h('div', { class: 'tutorial__demo' }, [
      h('p', { class: 'tutorial__demo-label' }, 'How it works'),
      demoBodyEl,
    ]);
    var grid = h('div', { class: 'tutorial__grid' }, [copyCol, demoCol]);

    var counterEl = h('span', { class: 'tutorial__counter' });
    var closeBtn = h('button',
      { class: 'tutorial__close', type: 'button', 'aria-label': 'Close tutorial' }, '×');
    var headEl = h('div', { class: 'tutorial__head' }, [
      h('p', { class: 'tutorial__brand' }, 'Sessionably Claims · Quick Start'),
      h('div', { class: 'tutorial__headmeta' }, [counterEl, closeBtn]),
    ]);

    var progressEl = h('div', { class: 'tutorial__progress' });
    var segs = TUTORIAL_STEPS.map(function () {
      var s = h('span'); progressEl.appendChild(s); return s;
    });

    var backBtn = h('button', { class: 'btn btn--ghost', type: 'button' }, 'Back');
    var nextBtn = h('button', { class: 'btn btn--primary', type: 'button' });
    var skipBtn = h('button', { class: 'tutorial__skip', type: 'button' }, 'Skip for now');
    var footEl = h('div', { class: 'tutorial__foot' }, [
      skipBtn,
      h('div', { class: 'tutorial__foot-actions' }, [backBtn, nextBtn]),
    ]);

    var root = h('div', { class: 'tutorial' }, [headEl, progressEl, grid, footEl]);

    function render() {
      var step = TUTORIAL_STEPS[index];
      var last = index === TUTORIAL_STEPS.length - 1;
      badgeEl.textContent = step.badge;
      eyebrowEl.textContent = step.eyebrow;
      titleEl.textContent = step.title;
      ledeEl.textContent = step.body;
      calloutTextEl.textContent = step.callout;
      counterEl.textContent = (index + 1) + ' of ' + TUTORIAL_STEPS.length;
      segs.forEach(function (seg, i) { seg.classList.toggle('is-filled', i <= index); });
      while (demoBodyEl.firstChild) demoBodyEl.removeChild(demoBodyEl.firstChild);
      demoBodyEl.appendChild(step.demo());
      backBtn.style.visibility = index === 0 ? 'hidden' : 'visible';
      nextBtn.textContent = last ? 'Add your first client →' : 'Next →';
    }

    render();

    var modal = openModal({ bodyNode: root, onClose: function () { finish(); } });
    modal.panel.classList.add('modal__panel--tutorial');
    if (modal.panel.parentNode) modal.panel.parentNode.classList.add('modal__backdrop--tutorial');
    modal.panel.setAttribute('aria-labelledby', HEADING_ID);

    var finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      markTutorialSeen();
      modal.close();
    }

    closeBtn.addEventListener('click', finish);
    skipBtn.addEventListener('click', finish);
    backBtn.addEventListener('click', function () { if (index > 0) { index--; render(); } });
    nextBtn.addEventListener('click', function () {
      if (index < TUTORIAL_STEPS.length - 1) { index++; render(); return; }
      finish();
      window.location.hash = '#clients';
    });

    return modal;
  }

  // Auto-open on first run for a clinician who has not dismissed it. Called from
  // the shell once /me resolves (app.js). Never blocks; safe to call repeatedly.
  function maybeAutoOpenTutorial() {
    if (tutorialSeen()) return;
    openTutorial();
  }

  // ---------------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------------
  window.Reddably = {
    api: api,
    routes: routes,
    registerView: registerView,
    navigate: navigate,
    // rendering helpers
    h: h,
    clear: clear,
    renderLoading: renderLoading,
    renderError: renderError,
    renderEmpty: renderEmpty,
    // overlays / feedback
    toast: toast,
    openModal: openModal,
    confirmModal: confirmModal,
    formModal: formModal,
    // onboarding walkthrough
    openTutorial: openTutorial,
    maybeAutoOpenTutorial: maybeAutoOpenTutorial,
    createPayerPicker: createPayerPicker,
    createDiagnosisPicker: createDiagnosisPicker,
    // formatting
    fmtMoney: fmtMoney,
    fmtDate: fmtDate,
    statusBadge: statusBadge,
    scrubVendor: scrubVendor,
  };
})(window, document);
