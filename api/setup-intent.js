'use strict';

// POST /setup-intent — PUBLIC Vercel adapter (no JWT), Stripe egress. Called by the
// patient card-capture page (public/card-setup.html).
//
// The VPC-private RDS is unreachable from Vercel, so DB access lives on the Lambda
// API. This adapter resolves the client behind the signed token via
//   POST {LAMBDA_API_BASE}/card-setup/context   { token }
// ensures a Stripe Customer exists (creating one on Stripe and persisting it via
//   POST {LAMBDA_API_BASE}/card-setup/save-customer  { token, stripe_customer_id }),
// then returns a SetupIntent client_secret + publishable key for Stripe.js.
// No card data touches this function (PCI: collected by Stripe.js); never log PHI.

const stripe = require('../backend/lib/stripe');
const { callLambda } = require('../backend/lib/lambda_api');
const { isValidEmail } = require('../backend/lib/email');
const { ALLOWED_ORIGINS, DEFAULT_ORIGIN } = require('../backend/lib/response');

function applyCors(req, res) {
  const origin = req.headers.origin;
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : DEFAULT_ORIGIN;
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function parseBody(req) {
  if (req.body == null) return {};
  if (typeof req.body === 'object') return req.body;
  try {
    return JSON.parse(req.body);
  } catch (_) {
    return {};
  }
}

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = parseBody(req);
    const token = body.token;

    // Resolve the client (DB) via the Lambda API; it verifies the token.
    const ctxRes = await callLambda('/card-setup/context', { method: 'POST', body: { token } });
    if (ctxRes.status !== 200) {
      return res.status(ctxRes.status).json(ctxRes.data || { error: 'Could not start card setup.' });
    }
    const client = ctxRes.data || {};

    // Create the Stripe Customer once, then reuse it on subsequent visits.
    let customerId = client.stripe_customer_id;
    if (!customerId) {
      // Stripe rejects a malformed email outright ("Invalid email address: qujo"),
      // which used to 500 the whole request and leave the patient staring at a
      // generic "temporarily unavailable" page. The email is optional on a Stripe
      // Customer and is not needed to capture a card, so a missing/garbage value
      // is simply omitted — the card-setup link keeps working. Log the client id
      // only (never the address itself: that is PHI) so it stays diagnosable.
      const rawEmail = typeof client.email === 'string' ? client.email.trim() : '';
      const email = isValidEmail(rawEmail) ? rawEmail : undefined;
      if (!email) {
        console.warn('setup_intent: client email missing or invalid; creating Stripe customer without it', {
          client_id: client.client_id,
        });
      }

      const customer = await stripe.createCustomer({
        name: `${client.first_name || ''} ${client.last_name || ''}`.trim() || undefined,
        email,
        metadata: { client_id: client.client_id, practice_id: client.practice_id },
      });
      customerId = customer.id;
      // Persist via the Lambda API (first-writer-wins on the client row).
      await callLambda('/card-setup/save-customer', {
        method: 'POST',
        body: { token, stripe_customer_id: customerId },
      });
    }

    const setupIntent = await stripe.createSetupIntent({ customer: customerId });

    return res.status(200).json({
      clientSecret: setupIntent.client_secret,
      publishableKey: stripe.publishableKey(),
    });
  } catch (err) {
    console.error('setup_intent error:', err && err.message);
    return res.status(500).json({ error: 'Could not start card setup.' });
  }
};
