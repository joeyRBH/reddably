'use strict';

// Unit test — the Vercel setup-intent adapter (api/setup-intent.js).
// Mocks the Stripe client and the Lambda API client via the require cache, so the
// test exercises the orchestration only.
//
// The behavior pinned down here: a client whose stored email is missing, blank, or
// malformed must STILL get a working card-setup link. Stripe rejects a garbage
// address outright ("Invalid email address: qujo"), which used to 500 the request
// and show the patient a generic "temporarily unavailable" page. Email is optional
// on a Stripe Customer, so the adapter omits it rather than failing the request —
// and warns with the client id only (never the address: PHI).
//
//   node backend/tests/setup_intent_adapter.test.js

const assert = require('node:assert');
const path = require('node:path');

function mock(rel, exports) {
  const resolved = require.resolve(path.join(__dirname, '..', rel));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// Spyable Stripe: records the createCustomer params and hands back a customer +
// SetupIntent. createCustomer also mimics Stripe's real rejection of a malformed
// email, so a regression (passing "qujo" through) fails this test loudly.
const stripeSpy = { customerCalls: 0, lastCustomerParams: null, setupIntentCalls: 0 };
mock('lib/stripe.js', {
  createCustomer: async (params) => {
    stripeSpy.customerCalls += 1;
    stripeSpy.lastCustomerParams = params;
    if (params.email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(params.email))) {
      throw new Error(`Invalid email address: ${params.email}`);
    }
    return { id: 'cus_new' };
  },
  createSetupIntent: async () => {
    stripeSpy.setupIntentCalls += 1;
    return { client_secret: 'seti_1_secret_x' };
  },
  publishableKey: () => 'pk_test_123',
});

// Scriptable Lambda API: the card-setup context response is set per test.
const lambda = { contextRes: null, saveCustomerCalls: 0 };
mock('lib/lambda_api.js', {
  BASE: 'https://api.test',
  callLambda: async (p) => {
    if (/\/card-setup\/context$/.test(p)) return lambda.contextRes;
    if (/\/card-setup\/save-customer$/.test(p)) {
      lambda.saveCustomerCalls += 1;
      return { status: 200, ok: true, data: { ok: true } };
    }
    return { status: 404, ok: false, data: {} };
  },
});

const setupIntent = require(path.join(__dirname, '..', '..', 'api', 'setup-intent.js'));

function makeRes() {
  return {
    statusCode: null, payload: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.payload = obj; return this; },
    end() { return this; },
  };
}
function req() {
  return { method: 'POST', headers: { origin: 'https://claims.sessionably.com' }, body: { token: 'tok-1' } };
}
function context(clientOverrides) {
  return {
    status: 200,
    ok: true,
    data: Object.assign(
      {
        client_id: 'cl-1',
        practice_id: 'pr-1',
        first_name: 'Pat',
        last_name: 'Doe',
        stripe_customer_id: null,
      },
      clientOverrides
    ),
  };
}
function reset() {
  stripeSpy.customerCalls = 0;
  stripeSpy.lastCustomerParams = null;
  stripeSpy.setupIntentCalls = 0;
  lambda.contextRes = null;
  lambda.saveCustomerCalls = 0;
  warnings.length = 0;
}

// Capture console.warn so we can assert the warning carries the client id and
// nothing that could be PHI (no email address).
const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => { warnings.push(args); };

(async () => {
  // 1. The prod failure: a garbage stored email ("qujo"). The SetupIntent must
  //    still be created, with the email simply omitted from the Stripe Customer.
  reset();
  lambda.contextRes = context({ email: 'qujo' });
  let res = makeRes();
  await setupIntent(req(), res);
  assert.strictEqual(res.statusCode, 200, 'a malformed email no longer 500s the request');
  assert.strictEqual(res.payload.clientSecret, 'seti_1_secret_x', 'returns the SetupIntent secret');
  assert.strictEqual(res.payload.publishableKey, 'pk_test_123', 'returns the publishable key');
  assert.strictEqual(stripeSpy.customerCalls, 1, 'the customer is created once');
  assert.strictEqual(
    stripeSpy.lastCustomerParams.email,
    undefined,
    'the invalid email is NOT passed to Stripe at all'
  );
  assert.strictEqual(stripeSpy.lastCustomerParams.name, 'Pat Doe', 'the name is still sent');
  assert.strictEqual(stripeSpy.setupIntentCalls, 1, 'the SetupIntent is still created');
  assert.strictEqual(lambda.saveCustomerCalls, 1, 'the new customer id is persisted');
  assert.strictEqual(warnings.length, 1, 'exactly one warning is logged');
  const warned = JSON.stringify(warnings[0]);
  assert.ok(warned.includes('cl-1'), 'the warning names the client id');
  assert.ok(!warned.includes('qujo'), 'the warning never contains the email value (PHI)');

  // 2. Null email — the common case for a client added without one.
  reset();
  lambda.contextRes = context({ email: null });
  res = makeRes();
  await setupIntent(req(), res);
  assert.strictEqual(res.statusCode, 200, 'a null email succeeds');
  assert.strictEqual(stripeSpy.lastCustomerParams.email, undefined, 'no email sent to Stripe');
  assert.strictEqual(stripeSpy.setupIntentCalls, 1, 'the SetupIntent is created');
  assert.strictEqual(warnings.length, 1, 'a warning is logged');

  // 3. Blank / whitespace-only email.
  reset();
  lambda.contextRes = context({ email: '   ' });
  res = makeRes();
  await setupIntent(req(), res);
  assert.strictEqual(res.statusCode, 200, 'a blank email succeeds');
  assert.strictEqual(stripeSpy.lastCustomerParams.email, undefined, 'no email sent to Stripe');

  // 4. Missing key entirely.
  reset();
  lambda.contextRes = context({});
  res = makeRes();
  await setupIntent(req(), res);
  assert.strictEqual(res.statusCode, 200, 'an absent email key succeeds');
  assert.strictEqual(stripeSpy.lastCustomerParams.email, undefined, 'no email sent to Stripe');

  // 5. A domain with no dot ("a@b") is what SES/Stripe reject — treat it as invalid.
  reset();
  lambda.contextRes = context({ email: 'a@b' });
  res = makeRes();
  await setupIntent(req(), res);
  assert.strictEqual(res.statusCode, 200, 'a dotless domain succeeds');
  assert.strictEqual(stripeSpy.lastCustomerParams.email, undefined, 'no email sent to Stripe');

  // 6. A VALID email is still forwarded to Stripe (and warns about nothing).
  reset();
  lambda.contextRes = context({ email: '  patient@example.com  ' });
  res = makeRes();
  await setupIntent(req(), res);
  assert.strictEqual(res.statusCode, 200, 'a valid email succeeds');
  assert.strictEqual(
    stripeSpy.lastCustomerParams.email,
    'patient@example.com',
    'a valid email is trimmed and forwarded to Stripe'
  );
  assert.strictEqual(warnings.length, 0, 'no warning for a valid email');

  // 7. An existing Stripe customer short-circuits customer creation entirely —
  //    a bad stored email must not even be looked at on the reuse path.
  reset();
  lambda.contextRes = context({ email: 'qujo', stripe_customer_id: 'cus_existing' });
  res = makeRes();
  await setupIntent(req(), res);
  assert.strictEqual(res.statusCode, 200, 'the reuse path succeeds');
  assert.strictEqual(stripeSpy.customerCalls, 0, 'no customer created when one exists');
  assert.strictEqual(stripeSpy.setupIntentCalls, 1, 'the SetupIntent is created');
  assert.strictEqual(warnings.length, 0, 'no warning on the reuse path');

  // 8. An upstream context failure still passes its status through unchanged.
  reset();
  lambda.contextRes = { status: 404, ok: false, data: { error: 'This link is no longer valid.' } };
  res = makeRes();
  await setupIntent(req(), res);
  assert.strictEqual(res.statusCode, 404, 'the upstream status is passed through');
  assert.strictEqual(stripeSpy.customerCalls, 0, 'Stripe is never called');

  console.warn = realWarn;
  console.log('setup_intent_adapter.test.js: all assertions passed');
})().catch((err) => {
  console.warn = realWarn;
  console.error(err);
  process.exit(1);
});
