'use strict';

// Card-setup resource — the DB side of the PUBLIC patient card-capture flow.
// Runs in the VPC (reaches RDS); the Stripe calls stay on the Vercel adapters
// (api/setup-intent.js, api/save-payment-method.js) which have outbound egress.
// Those adapters call these routes over HTTPS for all DB access:
//
//   POST /card-setup/context              → resolve the client behind the token
//   POST /card-setup/save-customer        → persist a newly created Stripe customer id
//   POST /card-setup/save-payment-method  → persist the display-only card summary
//   POST /card-setup/save-insurance       → persist the patient's OON insurance info
//   POST /card-setup/payer-search         → type-ahead payer lookup (Stedi) for the
//                                           patient's insurance-company field
//
// Auth: the short-lived signed payment token (lib/payment_token) carried in the
// body as { token } — the same credential the Vercel functions verified before.
// The token yields a client_id; every query is scoped to that client. This is a
// patient (non-staff) flow, so there is no requireAuth / practice JWT here.
// Never store a raw PAN/CVC (PCI); never log PHI.
//
// Intake does NOT make a client billable. It writes the patient's answers to the
// chart, but a clinician confirms them there ("Save as default" on the client
// chart) before the client becomes 'active'. This flow therefore writes NO status
// at all: a patient who finishes intake stays 'awaiting_info' until a human says
// otherwise. It used to auto-promote 'awaiting_info' → 'active' the moment the
// answers looked complete, with no one in the loop — a fuzzy self-reported form
// made someone billable. See intakeCompleteness for the readiness rule the chart's
// confirm affordance mirrors.

const db = require('../lib/db');
const paymentToken = require('../lib/payment_token');
const { json, preflight } = require('../lib/response');
const { parseBody, normalizePhone } = require('../lib/util');
const { audit } = require('../lib/audit');
const stedi = require('../lib/clearinghouse/stedi');
const email = require('../lib/email');

function httpMethod(event) {
  if (!event) return '';
  if (event.httpMethod) return event.httpMethod;
  const ctx = event.requestContext;
  return (ctx && ctx.http && ctx.http.method) || '';
}

// Path tail after "card-setup/" so routing is payload-format agnostic.
function subPath(event) {
  const raw =
    (event && event.rawPath) ||
    (event && event.requestContext && event.requestContext.http && event.requestContext.http.path) ||
    (event && event.path) ||
    '';
  const cleaned = String(raw).replace(/^\/+|\/+$/g, '');
  const idx = cleaned.indexOf('card-setup/');
  return idx === -1 ? '' : cleaned.slice(idx + 'card-setup/'.length);
}

// Resolve the client_id from the token, or throw. Kept separate so every route
// enforces the same token check.
function clientIdFromBody(body) {
  const { client_id: clientId } = paymentToken.verify(body.token);
  return clientId;
}

async function loadClient(clientId) {
  const r = await db.query(
    `select * from clients where id = $1 and is_hidden = false limit 1`,
    [clientId]
  );
  return r.rows[0] || null;
}

// Resolve the practice's notification recipient for intake alerts: the explicit
// practices.notification_email ONLY. There is deliberately no fallback to a staff
// login — a practice_admin's `email` may be a username (e.g. "BigRedd"), and
// handing that to SES fails with "Missing final '@domain'". Returns null when
// no notification_email is set (the caller then simply skips the email); the
// email helper independently rejects any non-email value. Best-effort; never
// throws to the request path.
async function resolveNotificationEmail(practiceId) {
  try {
    const r = await db.query(
      `select nullif(notification_email, '') as recipient
         from practices
        where id = $1
        limit 1`,
      [practiceId]
    );
    const recipient = r.rows[0] && r.rows[0].recipient;
    return recipient && String(recipient).trim() !== '' ? String(recipient).trim() : null;
  } catch (err) {
    console.warn('card_setup resolveNotificationEmail failed:', err && err.message);
    return null;
  }
}

// Fire the "patient submitted their information" admin email after the final
// intake step (insurance saved). This is a REVIEW request — the client is not
// billable until a clinician confirms on the chart. Best-effort and fully
// non-blocking: any failure (SES not verified yet, no recipient, send error) is
// logged and swallowed so the patient's request still succeeds. PHI-minimal —
// only the client's name + a chart link are sent.
async function notifyIntakeComplete(client) {
  try {
    const to = await resolveNotificationEmail(client.practice_id);
    if (!to) return;
    const clientName = [client.first_name, client.last_name].filter(Boolean).join(' ').trim();
    await email.sendIntakeCompletionEmail({
      to,
      clientId: client.id,
      clientName,
      completedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn('card_setup notifyIntakeComplete failed:', err && err.message);
  }
}

// Trim to a string, capping length. Returns '' for non-strings / null.
const MAX_FIELD_LEN = 200;
function cleanField(v) {
  if (typeof v !== 'string') return '';
  return v.trim();
}

// --- intake readiness ---------------------------------------------------------
//
// This is the DEFINITION of "the patient has given us everything a claim needs".
// It no longer changes anything on its own: it used to back an auto-promotion to
// 'active' that ran with no human in the loop, and that promotion is gone. It
// stays as the single written statement of the rule — the client chart's "Save as
// default" affordance mirrors it to decide when to offer the confirm.

// Is this client claim-ready? True only when intake has produced everything an
// 837P needs FROM THE PATIENT:
//   * demographics — date of birth + a full address (details step), and
//   * insurance — carrier, member id, and a real payer_id.
// The payer_id is what routes the claim, and it only exists when the patient picked
// a directory match; a free-typed carrier name can't be routed. A card on file is
// deliberately NOT part of this — a practice can bill a client who never saved one.
//
// Read back from the DB rather than trusting the just-posted body: a patient who
// re-opens the link and re-submits a single step is then judged on the row's actual
// state, not on the one step in front of us.
async function intakeCompleteness(clientId) {
  const r = await db.query(
    `select
        (c.date_of_birth is not null
          and nullif(btrim(c.address_line1), '') is not null
          and nullif(btrim(c.city), '') is not null
          and nullif(btrim(c.state), '') is not null
          and nullif(btrim(c.postal_code), '') is not null)   as demographics_ok,
        (i.id is not null
          and nullif(btrim(i.carrier_name), '') is not null
          and nullif(btrim(i.member_id), '') is not null
          and nullif(btrim(i.payer_id), '') is not null)      as insurance_ok
       from clients c
       left join lateral (
         select id, carrier_name, member_id, payer_id
           from insurance_records
          where client_id = c.id and is_primary = true and is_hidden = false
          order by created_at asc
          limit 1
       ) i on true
      where c.id = $1 and c.is_hidden = false`,
    [clientId]
  );
  const row = r.rows[0];
  if (!row) return { demographicsOk: false, insuranceOk: false };
  return {
    demographicsOk: row.demographics_ok === true,
    insuranceOk: row.insurance_ok === true,
  };
}

// NOTE: activateIfIntakeComplete used to live here and promoted 'awaiting_info' →
// 'active' from both intake steps. It is deliberately GONE, not merely unwired: a
// helper whose whole job is to make a client billable without a human is one call
// site away from coming back. Confirmation is now a staff action on the client
// chart, which goes through the ordinary authenticated PATCH /clients/{id} and is
// audited there like any other staff status change.

exports.handler = async (event) => {
  const method = httpMethod(event);
  if (method === 'OPTIONS') return preflight(event);
  if (method !== 'POST') return json(405, { error: 'Method not allowed' }, event);

  const body = parseBody(event);

  // Token is the credential for every route here.
  let clientId;
  try {
    clientId = clientIdFromBody(body);
  } catch (_) {
    return json(401, { error: 'Invalid or expired link.' }, event);
  }

  try {
    const path = subPath(event);

    if (path === 'context') {
      const client = await loadClient(clientId);
      if (!client) return json(404, { error: 'Not found' }, event);
      await audit(event, { actorType: 'patient_link', practiceId: client.practice_id }, {
        action: 'patient_link.access',
        resourceType: 'client',
        resourceId: client.id,
      });
      return json(
        200,
        {
          client_id: client.id,
          practice_id: client.practice_id,
          stripe_customer_id: client.stripe_customer_id || null,
          first_name: client.first_name || null,
          last_name: client.last_name || null,
          email: client.email || null,
        },
        event
      );
    }

    if (path === 'save-customer') {
      const customerId = body.stripe_customer_id;
      if (!customerId || typeof customerId !== 'string') {
        return json(400, { error: 'Missing stripe_customer_id.' }, event);
      }
      // Only set it if not already present (first writer wins), scoped to the token's client.
      await db.query(
        `update clients set stripe_customer_id = $1
          where id = $2 and is_hidden = false and stripe_customer_id is null`,
        [customerId, clientId]
      );
      return json(200, { ok: true }, event);
    }

    if (path === 'save-payment-method') {
      const paymentMethodId = body.paymentMethodId;
      if (!paymentMethodId || typeof paymentMethodId !== 'string') {
        return json(400, { error: 'Missing paymentMethodId.' }, event);
      }
      const pmRes = await db.query(
        `update clients
            set payment_method_id = $1,
                payment_method_brand = $2,
                payment_method_last4 = $3,
                payment_method_exp_month = $4,
                payment_method_exp_year = $5,
                payment_method_set_at = now()
          where id = $6 and is_hidden = false
          returning practice_id`,
        [
          paymentMethodId,
          body.brand || null,
          body.last4 || null,
          body.exp_month != null ? body.exp_month : null,
          body.exp_year != null ? body.exp_year : null,
          clientId,
        ]
      );
      await audit(
        event,
        { actorType: 'patient_link', practiceId: pmRes.rows[0] ? pmRes.rows[0].practice_id : null },
        { action: 'patient_link.save_payment_method', resourceType: 'client', resourceId: clientId }
      );
      return json(200, { ok: true }, event);
    }

    // Type-ahead payer lookup for the patient's insurance-company field. The
    // token is the credential (verified above); no requireAuth. The only input
    // is a free-text payer-name fragment (a payer-name fragment is not PHI) and
    // the response is public payer-directory data, so nothing is persisted here.
    if (path === 'payer-search') {
      const q = cleanField(body.q);
      if (q.length < 2 || q.length > 200) {
        return json(400, { error: 'Query must be between 2 and 200 characters.' }, event);
      }
      try {
        const payers = await stedi.searchPayers(q);
        return json(200, { payers }, event);
      } catch (err) {
        // No PHI in a payer-name search; log only the message.
        console.error('card_setup payer-search error:', err && err.message);
        return json(502, { error: 'Could not search payers.' }, event);
      }
    }

    if (path === 'save-details') {
      // Patient-supplied demographics needed to build a claim: date of birth,
      // biological sex, and current address. Persisted to the clients row (columns already exist —
      // db/migrations/002). All optional individually; a blank field never nulls
      // out existing data (coalesce(nullif(...))). No card/PCI data here.
      const dateOfBirth = cleanField(body.date_of_birth);
      // Patient's biological sex — the 837P subscriber demographic required when the
      // patient IS the subscriber ('self'). Same female|male|unknown vocabulary the
      // clients_gender_check CHECK enforces; lower-cased before validating.
      const gender = cleanField(body.gender).toLowerCase();
      const addressLine1 = cleanField(body.address_line1);
      const addressLine2 = cleanField(body.address_line2);
      const city = cleanField(body.city);
      const state = cleanField(body.state);
      const postalCode = cleanField(body.postal_code);
      const phoneRaw = cleanField(body.phone);

      for (const v of [addressLine1, addressLine2, city, state, postalCode]) {
        if (v.length > MAX_FIELD_LEN) return json(400, { error: 'One of the fields is too long.' }, event);
      }
      if (dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
        return json(400, { error: 'Date of birth must be YYYY-MM-DD.' }, event);
      }
      if (gender && !['female', 'male', 'unknown'].includes(gender)) {
        return json(400, { error: 'Invalid biological sex.' }, event);
      }

      // Optional phone: normalize to E.164 (Twilio SMS requires it). Blank is
      // fine — a blank never nulls the existing value (coalesce below). A
      // non-blank value that can't normalize is a clear 400, not stored garbage.
      let phone = '';
      if (phoneRaw !== '') {
        const res = normalizePhone(phoneRaw);
        if (!res.ok) {
          return json(400, { error: 'Please enter a valid US phone number.' }, event);
        }
        phone = res.value;
      }

      const result = await db.query(
        `update clients set
            date_of_birth = coalesce(nullif($1, '')::date, date_of_birth),
            gender        = coalesce(nullif($2, ''), gender),
            address_line1 = coalesce(nullif($3, ''), address_line1),
            address_line2 = coalesce(nullif($4, ''), address_line2),
            city          = coalesce(nullif($5, ''), city),
            state         = coalesce(nullif($6, ''), state),
            postal_code   = coalesce(nullif($7, ''), postal_code),
            phone         = coalesce(nullif($8, ''), phone)
          where id = $9 and is_hidden = false
          returning practice_id`,
        [dateOfBirth, gender, addressLine1, addressLine2, city, state, postalCode, phone, clientId]
      );
      if (result.rowCount === 0) return json(404, { error: 'Not found' }, event);
      await audit(
        event,
        { actorType: 'patient_link', practiceId: result.rows[0] ? result.rows[0].practice_id : null },
        { action: 'patient_link.save_details', resourceType: 'client', resourceId: clientId }
      );

      // No status write here. Demographics landing on the chart does not make the
      // client billable — a clinician confirms on the chart.
      return json(200, { ok: true }, event);
    }

    if (path === 'save-insurance') {
      // Patient-supplied OON insurance info. Required: carrier_name, member_id, and
      // payer_id — UNLESS payer_not_listed is set (see below). Optional:
      // group_number, subscriber_relationship, subscriber_name, subscriber_dob.
      // Trim everything; reject anything over 200 chars.
      const carrierName = cleanField(body.carrier_name);
      const memberId = cleanField(body.member_id);
      const groupNumber = cleanField(body.group_number);
      const subscriberRelationship = cleanField(body.subscriber_relationship);
      const subscriberName = cleanField(body.subscriber_name);
      const subscriberDob = cleanField(body.subscriber_dob);
      // Policyholder (dependent-subscriber) demographics — CMS-1500 Box 7 / 11a.
      // Only meaningful when the patient is NOT the policyholder; cleared on 'self'
      // (see subscriberIsSelf below). Gender is lower-cased and validated against
      // the same female|male|unknown vocabulary the DB CHECK enforces.
      const subscriberGender = cleanField(body.subscriber_gender).toLowerCase();
      const subscriberAddress1 = cleanField(body.subscriber_address_line1);
      const subscriberAddress2 = cleanField(body.subscriber_address_line2);
      const subscriberCity = cleanField(body.subscriber_city);
      const subscriberState = cleanField(body.subscriber_state);
      const subscriberPostal = cleanField(body.subscriber_postal_code);
      // payer_id maps to insurance_records.payer_id varchar(50). It exists only when
      // the patient PICKED a payer-directory match — free text never yields one.
      const payerId = cleanField(body.payer_id);

      // Escape hatch: the patient explicitly said they can't find their insurance
      // company in the directory. Saves whatever they have with a null payer_id and
      // leaves the client on 'awaiting_info' for staff follow-up. Deliberately an
      // explicit boolean flag, so it can only ever be a chosen path — never the
      // silent default that an absent payer_id used to be.
      const payerNotListed = body.payer_not_listed === true;

      if (!carrierName) return json(400, { error: 'Insurance company is required.' }, event);
      if (!memberId) return json(400, { error: 'Member ID is required.' }, event);

      // The claim can't be routed without a payer id, so a picked match is required.
      // Enforced HERE and not only in the page: client-side gating is a prompt, not a
      // gate — this route is reachable with nothing but the signed link token.
      if (!payerId && !payerNotListed) {
        return json(
          400,
          { error: 'Please choose the insurance company from the list of matches.' },
          event
        );
      }

      for (const v of [
        carrierName, memberId, groupNumber, subscriberRelationship, subscriberName, subscriberDob,
        subscriberAddress1, subscriberAddress2, subscriberCity, subscriberState, subscriberPostal,
      ]) {
        if (v.length > MAX_FIELD_LEN) return json(400, { error: 'One of the fields is too long.' }, event);
      }
      if (payerId.length > 50) return json(400, { error: 'One of the fields is too long.' }, event);
      if (subscriberRelationship && !['self', 'spouse', 'child', 'other'].includes(subscriberRelationship)) {
        return json(400, { error: 'Invalid policyholder relationship.' }, event);
      }
      if (subscriberDob && !/^\d{4}-\d{2}-\d{2}$/.test(subscriberDob)) {
        return json(400, { error: 'Date of birth must be YYYY-MM-DD.' }, event);
      }
      if (subscriberGender && !['female', 'male', 'unknown'].includes(subscriberGender)) {
        return json(400, { error: 'Invalid policyholder gender.' }, event);
      }

      // When the patient IS the policyholder, no dependent-subscriber demographics
      // apply. Clear them (below) rather than coalescing, so a patient who first
      // said "child" and then corrected to "self" doesn't leave stale policyholder
      // PHI on the record. The relationship select on the page always sends a value,
      // so an explicit 'self' is a reliable trigger.
      const subscriberIsSelf = subscriberRelationship === 'self';

      // Authoritative either way — the id the patient picked, or an explicit null when
      // they used the escape hatch. Deliberately NOT coalesced onto the existing value:
      // an id left over from an earlier pick would no longer match the carrier name
      // being saved now, and a stale payer id routes the claim to the wrong payer.
      const payerIdOrNull = payerNotListed ? null : payerId;

      const client = await loadClient(clientId);
      if (!client) return json(404, { error: 'Not found' }, event);

      // Find an existing primary (non-hidden) record to update in place.
      const existing = await db.query(
        `select id from insurance_records
          where client_id = $1 and is_primary = true and is_hidden = false
          order by created_at asc limit 1`,
        [clientId]
      );

      if (existing.rows[0]) {
        // Update only the fields the patient actually provided — never null out
        // existing data with a blank. coalesce(nullif($n, ''), col) keeps the
        // current value when the incoming field is blank. EXCEPTION: when the
        // patient is the policyholder ($5 subscriberIsSelf), every dependent-
        // subscriber column is force-cleared to NULL — a coalesce would otherwise
        // preserve stale policyholder PHI (name/DOB/gender/address) that then leaks
        // if the relationship later flips back to a dependent value.
        await db.query(
          `update insurance_records set
              carrier_name             = coalesce(nullif($1, ''), carrier_name),
              member_id                = coalesce(nullif($2, ''), member_id),
              group_number             = coalesce(nullif($3, ''), group_number),
              subscriber_relationship  = coalesce(nullif($4, ''), subscriber_relationship),
              subscriber_name          = case when $5::boolean then null else coalesce(nullif($6, ''), subscriber_name) end,
              subscriber_dob           = case when $5::boolean then null else coalesce(nullif($7, '')::date, subscriber_dob) end,
              subscriber_gender        = case when $5::boolean then null else coalesce(nullif($8, ''), subscriber_gender) end,
              subscriber_address_line1 = case when $5::boolean then null else coalesce(nullif($9, ''), subscriber_address_line1) end,
              subscriber_address_line2 = case when $5::boolean then null else coalesce(nullif($10, ''), subscriber_address_line2) end,
              subscriber_city          = case when $5::boolean then null else coalesce(nullif($11, ''), subscriber_city) end,
              subscriber_state         = case when $5::boolean then null else coalesce(nullif($12, ''), subscriber_state) end,
              subscriber_postal_code   = case when $5::boolean then null else coalesce(nullif($13, ''), subscriber_postal_code) end,
              payer_id                 = $14
            where id = $15`,
          [
            carrierName, memberId, groupNumber, subscriberRelationship, subscriberIsSelf,
            subscriberName, subscriberDob, subscriberGender,
            subscriberAddress1, subscriberAddress2, subscriberCity, subscriberState, subscriberPostal,
            payerIdOrNull, existing.rows[0].id,
          ]
        );
      } else {
        // No primary record yet — insert. On 'self' the policyholder columns are
        // stored NULL (blanked in JS below), matching the update's clear semantics.
        const insName = subscriberIsSelf ? '' : subscriberName;
        const insDob = subscriberIsSelf ? '' : subscriberDob;
        const insGender = subscriberIsSelf ? '' : subscriberGender;
        const insAddr1 = subscriberIsSelf ? '' : subscriberAddress1;
        const insAddr2 = subscriberIsSelf ? '' : subscriberAddress2;
        const insCity = subscriberIsSelf ? '' : subscriberCity;
        const insState = subscriberIsSelf ? '' : subscriberState;
        const insPostal = subscriberIsSelf ? '' : subscriberPostal;
        await db.query(
          `insert into insurance_records
             (practice_id, client_id, carrier_name, member_id, group_number,
              subscriber_relationship, subscriber_name, subscriber_dob,
              subscriber_gender, subscriber_address_line1, subscriber_address_line2,
              subscriber_city, subscriber_state, subscriber_postal_code, payer_id, is_primary)
           values ($1, $2, $3, $4, nullif($5, ''),
                   nullif($6, ''), nullif($7, ''), nullif($8, '')::date,
                   nullif($9, ''), nullif($10, ''), nullif($11, ''),
                   nullif($12, ''), nullif($13, ''), nullif($14, ''), $15, true)`,
          [
            client.practice_id,
            clientId,
            carrierName,
            memberId,
            groupNumber,
            subscriberRelationship,
            insName,
            insDob,
            insGender,
            insAddr1,
            insAddr2,
            insCity,
            insState,
            insPostal,
            payerIdOrNull,
          ]
        );
      }

      // Insurance is the final intake step: demographics + insurance are now on file
      // and waiting for review. Notify the practice admin. Non-blocking — a send
      // failure (SES not verified yet, etc.) never fails the patient's request.
      await notifyIntakeComplete(client);

      await audit(event, { actorType: 'patient_link', practiceId: client.practice_id }, {
        action: 'patient_link.save_insurance',
        resourceType: 'client',
        resourceId: client.id,
      });

      // No status write here either. The client stays 'awaiting_info' — on the
      // practice's follow-up list — until a clinician confirms on the chart.
      return json(200, { ok: true }, event);
    }

    return json(404, { error: 'Not found' }, event);
  } catch (err) {
    console.error('card_setup error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
