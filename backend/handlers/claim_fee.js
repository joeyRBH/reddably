'use strict';

// Claim platform-fee resource — the DB side of the post-submission fee charge.
// Runs in the VPC (reaches RDS); the Stripe PaymentIntent stays on the Vercel
// adapter (api/claims/[id]/charge-fee.js), which has outbound egress.
//
//   POST /claims/{id}/charge-fee/context → what (if anything) to charge
//   POST /claims/{id}/charge-fee/record  → record the transaction after charging
//
// The adapter forwards the caller's staff Bearer token. `context` scopes the claim
// to the caller's practice, applies idempotency, and returns the exact charge
// parameters (amount computed here — never trusted from the client). `record`
// recomputes the amount the same way and inserts the transactions row, accepting
// only the Stripe ids + status from the adapter. Best-effort by design. Never logs PHI.

const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');
const { parseBody } = require('../lib/util');

function httpMethod(event) {
  if (!event) return '';
  if (event.httpMethod) return event.httpMethod;
  const ctx = event.requestContext;
  return (ctx && ctx.http && ctx.http.method) || '';
}

function pathId(event) {
  return event && event.pathParameters ? event.pathParameters.id : undefined;
}

// Last path segment: 'context' or 'record'.
function subAction(event) {
  const raw =
    (event && event.rawPath) ||
    (event && event.requestContext && event.requestContext.http && event.requestContext.http.path) ||
    (event && event.path) ||
    '';
  const parts = String(raw).replace(/^\/+|\/+$/g, '').split('/');
  return parts[parts.length - 1] || '';
}

async function loadPracticeId(userId) {
  const r = await db.query(
    `select practice_id from users where id = $1 and is_active = true limit 1`,
    [userId]
  );
  return r.rows[0] ? r.rows[0].practice_id : null;
}

async function loadClaim(practiceId, claimId) {
  const r = await db.query(
    `select * from claims where id = $1 and practice_id = $2 and is_hidden = false limit 1`,
    [claimId, practiceId]
  );
  return r.rows[0] || null;
}

async function loadClient(practiceId, clientId) {
  const r = await db.query(`select * from clients where id = $1 and practice_id = $2 limit 1`, [clientId, practiceId]);
  return r.rows[0] || null;
}

async function loadPractice(practiceId) {
  const r = await db.query(`select * from practices where id = $1 limit 1`, [practiceId]);
  return r.rows[0] || null;
}

async function alreadyCharged(claimId) {
  const r = await db.query(
    `select 1 from transactions where claim_id = $1 and type = 'platform_fee' and status = 'paid' limit 1`,
    [claimId]
  );
  return r.rowCount > 0;
}

// Compute the fee in cents from the claim + practice, or 0 if nothing to charge.
function feeCents(claim, practice) {
  const percent = Number(practice.platform_fee_percent);
  const billed = Number(claim.billed_amount);
  if (!Number.isFinite(percent) || percent <= 0 || !Number.isFinite(billed) || billed <= 0) return 0;
  const cents = Math.round(billed * (percent / 100) * 100);
  return cents > 0 ? cents : 0;
}

exports.handler = async (event) => {
  const method = httpMethod(event);
  if (method === 'OPTIONS') return preflight(event);
  if (method !== 'POST') return json(405, { error: 'Method not allowed' }, event);

  let auth;
  try {
    auth = requireAuth(event);
  } catch (err) {
    return json(err.statusCode || 401, { error: 'Unauthorized' }, event);
  }

  try {
    const practiceId = await loadPracticeId(auth.user.sub);
    if (!practiceId) return json(401, { error: 'Unauthorized' }, event);

    const claimId = pathId(event);
    if (!claimId) return json(404, { error: 'Not found' }, event);

    const claim = await loadClaim(practiceId, claimId);
    if (!claim) return json(404, { error: 'Not found' }, event);

    const action = subAction(event);

    if (action === 'context') {
      // A REPLACEMENT (CMS frequency 7) claim never charges the platform fee: it is
      // a new claim row, but it supersedes a claim on which the fee was already
      // collected — charging again would bill the patient another 5% for the same
      // service. Authoritative enforcement lives HERE (the client also skips the
      // call), so an old or bypassed client still cannot double-charge. Keyed on the
      // reference OR the frequency, mirroring the submit-handler / builder gate.
      //
      // Edge noted for later: if the ORIGINAL's fee charge FAILED (never collected),
      // the fee is genuinely still owed and this skip means the replacement won't
      // collect it either. The default is deliberately "a replacement does not
      // re-charge"; a later change could detect a missing/failed original
      // platform_fee transaction and charge on the replacement instead.
      if (claim.corrects_claim_id != null || claim.submission_frequency_code === '7') {
        return json(200, { charge: false, reason: 'replacement_claim' }, event);
      }
      if (await alreadyCharged(claim.id)) {
        return json(200, { charge: false, reason: 'already_charged' }, event);
      }
      const client = await loadClient(practiceId, claim.client_id);
      const practice = await loadPractice(practiceId);
      if (!client || !practice) return json(404, { error: 'Not found' }, event);

      if (!client.payment_method_id || !client.stripe_customer_id) {
        return json(200, { charge: false, reason: 'no_payment_method' }, event);
      }

      const amountCents = feeCents(claim, practice);
      if (amountCents <= 0) {
        return json(200, { charge: false, reason: 'nothing_to_charge' }, event);
      }

      return json(
        200,
        {
          charge: true,
          amount_cents: amountCents,
          currency: 'usd',
          customer: client.stripe_customer_id,
          payment_method: client.payment_method_id,
          description: `Sessionably Claims platform fee — claim ${claim.id}`,
          metadata: { claim_id: claim.id, client_id: client.id, practice_id: practice.id },
        },
        event
      );
    }

    if (action === 'record') {
      const body = parseBody(event);
      const client = await loadClient(practiceId, claim.client_id);
      const practice = await loadPractice(practiceId);
      if (!client || !practice) return json(404, { error: 'Not found' }, event);

      // Recompute the amount here (authoritative) — never trust the adapter's number.
      const amountCents = feeCents(claim, practice);
      const feeDollars = amountCents / 100;
      const percent = Number(practice.platform_fee_percent);
      const status = body.status === 'paid' ? 'paid' : 'failed';
      const description = `Platform fee (${percent}%) for claim ${claim.id}`;

      try {
        await db.query(
          `insert into transactions
             (practice_id, client_id, claim_id, type, description, amount, currency, fee_payer,
              stripe_payment_intent_id, stripe_charge_id, status)
           values ($1, $2, $3, 'platform_fee', $4, $5, 'usd', 'client', $6, $7, $8)`,
          [
            practice.id,
            client.id,
            claim.id,
            description,
            feeDollars,
            body.intent_id || null,
            body.charge_id || null,
            status,
          ]
        );
      } catch (txErr) {
        console.error('claim_fee (transaction insert) error:', txErr && txErr.message);
        return json(200, { ok: false, recorded: false }, event);
      }

      return json(200, { ok: true, recorded: true }, event);
    }

    return json(404, { error: 'Not found' }, event);
  } catch (err) {
    console.error('claim_fee error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
