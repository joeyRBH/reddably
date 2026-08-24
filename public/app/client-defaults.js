/* =============================================================================
 * Reddably — saving a session/claim edit back as a client default
 * =============================================================================
 * ONE implementation of the "☐ Also save these as <Client>'s defaults" control,
 * shared by every form that edits a field a client can hold a default for
 * (public/app/views/clients.js session form, public/app/views/claims.js Edit
 * claim, and the onboarding defaults step). A second copy of these rules would
 * be a second, silently divergent definition of WHICH fields a checkbox writes
 * — and the thing it writes to is what seeds every future claim.
 *
 * Two guarantees this module exists to hold:
 *
 * 1. FIELD-LIMITED. The defaults payload is the intersection of
 *      (a) the defaultable fields,
 *      (b) the fields that form actually exposes, and
 *      (c) the keys present in the payload that was JUST successfully written.
 *    Source (c) is the load-bearing one: the payload is derived from the object
 *    handed to the API, never rebuilt from a `client` or `session` object in
 *    scope. Edit claim exposes dx / CPT / fee, so ticking the box there writes
 *    exactly those three and leaves place-of-service and modifiers untouched —
 *    they are absent from the request, not sent as null.
 *
 * 2. EMPTY VALUES NEVER CLEAR A DEFAULT. Only a non-empty submitted value is
 *    written. The two forms disagree about clears — the session form runs
 *    compact() and strips empties before sending, while Edit claim sends
 *    explicit clears (diagnosis_codes: [], cpt_code: null) — so mirroring the
 *    payload verbatim would make one checkbox mean "clear my default" on one
 *    screen and "leave it alone" on the other. Skipping empties makes it
 *    uniform, and blanking one session's CPT is a weak signal that the client's
 *    DEFAULT should be destroyed. Clearing a default stays the client Edit
 *    form's job, where it is the visible subject of the edit.
 *
 * The checkbox itself is deliberately NOT remembered between openings. It is an
 * explicit instruction to change future billing defaults, and pre-ticking it
 * from earlier state — even within one navigation — risks a clinician saving a
 * default without consciously choosing to on that attempt.
 *
 * Pure apart from the API calls it is handed: no DOM, no globals beyond
 * attaching to the existing Reddably namespace. Loaded after views.js.
 * ========================================================================== */
(function (window) {
  'use strict';

  var R = window.Reddably;
  if (!R) return;

  // session/claim field -> client column. MIRRORS CLIENT_DEFAULT_COLUMNS in
  // backend/lib/billing_fields.js; the two must be changed together.
  //
  // diagnosis_codes maps to itself: clients.diagnosis_codes predates the other
  // four defaults (migration 008) and kept its column name.
  var DEFAULTABLE = {
    cpt_code: 'default_cpt_code',
    place_of_service: 'default_place_of_service',
    fee: 'default_session_fee',
    procedure_modifiers: 'default_procedure_modifiers',
    diagnosis_codes: 'diagnosis_codes',
  };

  // Empty for this purpose: null, undefined, '', or an empty array. A 0 fee is
  // NOT empty — a genuinely free session is a real default worth keeping.
  function isEmpty(v) {
    if (v === null || v === undefined) return true;
    if (typeof v === 'string') return v.trim() === '';
    if (Array.isArray(v)) return v.length === 0;
    return false;
  }

  // Build the client-defaults payload from the payload that was just written.
  //
  //   submitted  the EXACT object sent to the session/claim API — not a client
  //              row, not a form snapshot, not a merge of either
  //   fieldNames the field names that form exposes (its `fields` list)
  //
  // Returns {} when there is nothing to save, so callers can skip the request.
  function buildPayload(submitted, fieldNames) {
    var out = {};
    if (!submitted) return out;
    var exposed = {};
    (fieldNames || []).forEach(function (n) { exposed[n] = true; });

    Object.keys(DEFAULTABLE).forEach(function (field) {
      if (!exposed[field]) return;                       // (b) not on this form
      if (!(field in submitted)) return;                 // (c) not in the write
      var value = submitted[field];
      if (isEmpty(value)) return;                        // never clear a default
      out[DEFAULTABLE[field]] = value;
    });
    return out;
  }

  // Run the authoritative write, then optionally the defaults write.
  //
  //   opts.write        () -> Promise   the session/claim write. AUTHORITATIVE.
  //   opts.saveDefaults boolean         did the user tick the box
  //   opts.clientId     string
  //   opts.payload      object          what opts.write sent
  //   opts.fieldNames   [string]
  //   opts.successMessage string|fn(result)  shown when only the primary write ran
  //   opts.partialMessage string        shown when the primary write succeeded
  //                                     and the defaults write did NOT
  //   opts.onSettled    ()              run after EITHER defaults outcome
  //
  // The contract, which is the reason this is a function and not four copies of
  // a .then() chain:
  //
  //   * The primary write happens FIRST and is never rolled back. There is no
  //     transaction spanning the two — they are separate resources behind
  //     separate Lambdas — which is exactly why the failure mode is spelled out
  //     rather than assumed.
  //   * A defaults failure is caught INSIDE the chain, so it can never surface
  //     through the caller's error path and be mistaken for a failed claim edit.
  //   * Three distinct terminal messages, one per outcome. The success copy
  //     names the defaults, so it cannot be reused for the partial case, and the
  //     partial case never reads as unqualified success.
  //   * onSettled runs on BOTH defaults outcomes, so the screen reloads either
  //     way and corroborates the message: the claim updated, the default did
  //     not.
  //   * The warning gets a long dwell — a warning about work the user must redo
  //     is useless if it disappears before it is read.
  //
  // Retry is safe by construction: both writes are pure field-set updates with
  // no counters, no appends and no minting, so re-submitting identical values is
  // a no-op-equivalent.
  // successMessage may be a string, or a function of the write's result — some
  // callers only learn what happened from the response (e.g. completing a
  // session auto-drafts a claim server-side, and the toast says so).
  function messageFor(message, result) {
    return typeof message === 'function' ? message(result) : message;
  }

  function submitWithDefaults(opts) {
    var partialDwellMs = 8000;
    return opts.write().then(function (result) {
      var success = messageFor(opts.successMessage, result);
      var defaults = opts.saveDefaults
        ? buildPayload(opts.payload, opts.fieldNames)
        : {};

      if (!Object.keys(defaults).length) {
        R.toast(success, 'success');
        if (opts.onSettled) opts.onSettled();
        return result;
      }

      return R.api.clients.update(opts.clientId, defaults).then(function () {
        R.toast(success + ' · defaults saved', 'success');
        if (opts.onSettled) opts.onSettled();
        return result;
      }, function () {
        R.toast(opts.partialMessage, 'warn', partialDwellMs);
        if (opts.onSettled) opts.onSettled();
        return result;
      });
    });
  }

  // The checkbox field descriptor, for splicing into a formModal `fields` list.
  // uiOnly so it is never collected into the submitted payload — it is an
  // instruction, not a field. onToggle reports its state to the caller, which is
  // how the state is read: formModal's collect() reads .value (always "on" for a
  // checkbox), not .checked.
  //
  // Never pre-ticked. See the header.
  function checkboxField(clientName, onChange) {
    return {
      name: 'save_as_client_defaults',
      label: 'Also save these as ' + (clientName || 'this client') + "'s defaults",
      type: 'checkbox',
      uiOnly: true,
      hint: 'Applies to future sessions only — nothing already scheduled or drafted changes.',
      onToggle: function (checked) { onChange(!!checked); },
    };
  }

  R.clientDefaults = {
    DEFAULTABLE: DEFAULTABLE,
    buildPayload: buildPayload,
    submitWithDefaults: submitWithDefaults,
    checkboxField: checkboxField,
  };
})(window);
