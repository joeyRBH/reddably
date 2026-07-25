'use strict';

// Runtime SSM Parameter Store access, shared by handlers that read or write
// parameters at request time (the auth Lambdas normally get their secrets
// hydrated onto the environment out-of-band by deploy.sh; this is for values
// that must live in SSM itself — e.g. the Google OAuth client credentials and
// the per-connection calendar refresh tokens, which are keyed by row id and so
// cannot be env vars).
//
// @aws-sdk/client-ssm is provided by the Node 20 Lambda runtime — not bundled
// in package.json (same convention as handlers/migrate.js), and required
// lazily so local unit tests can stub these exports without the SDK installed.
// Reached from the VPC via the SSM interface endpoint.
//
// Security: parameter VALUES are secrets (OAuth tokens, connection strings).
// NEVER log them; error messages carry the parameter name only.

let client; // one client per warm container

function getClient() {
  if (!client) {
    // Region comes from the Lambda runtime (AWS_REGION).
    const { SSMClient } = require('@aws-sdk/client-ssm');
    client = new SSMClient({});
  }
  return client;
}

// getParameter(name) -> decrypted value. Throws when the parameter is missing
// or empty — callers treat a configured-but-blank secret as a hard error.
async function getParameter(name) {
  const { GetParameterCommand } = require('@aws-sdk/client-ssm');
  const out = await getClient().send(
    new GetParameterCommand({ Name: name, WithDecryption: true })
  );
  const value = out && out.Parameter && out.Parameter.Value;
  if (!value) {
    throw new Error(`SSM parameter ${name} is empty or missing`);
  }
  return value;
}

// putParameter(name, value) -> void. SecureString with the account's default
// SSM key; Overwrite so re-connecting a calendar rotates the stored token in
// place. Throws on failure — callers must treat the write as transactional
// with whatever row references the parameter.
async function putParameter(name, value) {
  const { PutParameterCommand } = require('@aws-sdk/client-ssm');
  await getClient().send(
    new PutParameterCommand({
      Name: name,
      Value: value,
      Type: 'SecureString',
      Overwrite: true,
    })
  );
}

// deleteParameter(name) -> void. Idempotent: a parameter that is already gone
// (ParameterNotFound) is success, so retries and double-disconnects are safe.
async function deleteParameter(name) {
  const { DeleteParameterCommand } = require('@aws-sdk/client-ssm');
  try {
    await getClient().send(new DeleteParameterCommand({ Name: name }));
  } catch (err) {
    if (err && err.name === 'ParameterNotFound') return;
    throw err;
  }
}

module.exports = { getParameter, putParameter, deleteParameter };
