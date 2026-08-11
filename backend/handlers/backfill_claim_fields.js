'use strict';

// One-off claim-backfill Lambda (claimsub-<env>-backfill-claim-fields).
//
// Runs backend/scripts/backfill-claim-derived-fields.js from INSIDE the VPC, the
// same way the migrate Lambda applies the schema: RDS is publicly_accessible =
// false and there is no bastion, so an operator's laptop cannot reach the
// database at all. See infra/terraform/backfill.tf and infra/terraform/README.md.
//
// The script is the single implementation — this handler adds nothing but the
// connection string and an invocation surface. It re-derives two stranded fields
// (insurance_record_id, billed_amount) on draft/denied claims, filling only
// MISSING values. See the script header for the full behavior and the pre/post
// checks.
//
// DRY RUN IS THE DEFAULT. Writes happen ONLY when the invoke payload is exactly
// { "apply": true } (a strict boolean — the string "true" does not count, so a
// mis-typed payload reads as a dry run rather than a write):
//
//   # dry run — no writes, returns the summary:
//   aws lambda invoke --function-name claimsub-prod-backfill-claim-fields \
//     /tmp/backfill.json && cat /tmp/backfill.json
//
//   # apply — writes, in one transaction, audit-logged per claim:
//   aws lambda invoke --function-name claimsub-prod-backfill-claim-fields \
//     --payload '{"apply":true}' --cli-binary-format raw-in-base64-out \
//     /tmp/backfill.json && cat /tmp/backfill.json
//
// NOT invoked by deploy.sh, and never on a deploy — unlike migrate, which
// deploy.sh runs every time. An operator invokes this by hand, reads the dry-run
// summary, and only then decides to apply.
//
// Security: NEVER log the connection string (or anything derived from it). The
// summary carries claim ids only — no names, no amounts.

const db = require('../lib/db');
const { run, formatSummary } = require('../scripts/backfill-claim-derived-fields');

async function loadDatabaseUrl() {
  // Allow a pre-set env var (local runs); otherwise fetch the SecureString from SSM.
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  const name = process.env.DATABASE_URL_SSM_PARAM;
  if (!name) {
    throw new Error('DATABASE_URL_SSM_PARAM is not set');
  }

  // Required lazily, not at module load: @aws-sdk/client-ssm is provided by the
  // Node 20 Lambda runtime and is deliberately not a package.json dependency, so
  // a top-level require would make this handler unloadable (and untestable)
  // anywhere else. This path only runs when DATABASE_URL is unset.
  const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
  const ssm = new SSMClient({}); // region comes from the Lambda runtime (AWS_REGION).
  const out = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = out && out.Parameter && out.Parameter.Value;
  if (!value) {
    throw new Error('DATABASE_URL SSM parameter is empty');
  }
  return value;
}

// Remove anything that looks like a database URL from an error message before it
// is logged or returned. Driver and DNS errors readily embed the DSN it failed on
// ("getaddrinfo ENOTFOUND …", "password authentication failed for …"), and this
// handler's result goes to whoever invoked it AND to CloudWatch — neither should
// ever hold the credential. Scrubs the known URL first (it may contain characters
// the pattern would not span) and then any remaining postgres:// URI.
function scrubConnectionString(message, url) {
  let out = String(message == null ? '' : message);
  if (url) out = out.split(url).join('[redacted]');
  return out.replace(/postgres(?:ql)?:\/\/\S*/gi, '[redacted]');
}

// Writes require the payload to carry apply === true, as a real boolean. Anything
// else — absent, null, "true", 1 — is a dry run. The asymmetry is deliberate: the
// failure mode of a mis-read payload must be "did nothing", never "wrote".
function shouldApply(event) {
  return !!(event && event.apply === true);
}

exports.handler = async (event) => {
  const apply = shouldApply(event);
  let databaseUrl = null;
  try {
    // lib/db reads process.env.DATABASE_URL lazily on first query, so set it first.
    databaseUrl = await loadDatabaseUrl();
    process.env.DATABASE_URL = databaseUrl;

    const { plan, applied } = await run({ apply });
    const summary = formatSummary(plan, { applied });

    // CloudWatch keeps the operator's record of the run. Ids and counts only.
    console.log(summary);

    return {
      ok: true,
      applied: apply,
      counts: {
        would_attach_insurance: plan.changes.filter((c) => 'insuranceRecordId' in c).length,
        would_set_billed_amount: plan.changes.filter((c) => 'billedAmount' in c).length,
        affected: plan.changes.length,
        written: applied ? applied.length : 0,
        skipped: plan.skipped,
      },
      claim_ids: plan.changes.map((c) => c.id),
      summary,
    };
  } catch (err) {
    // Log only the message, scrubbed — never the connection string or a row's
    // contents. A driver error's own text can carry the DSN, so it is scrubbed
    // before it reaches either CloudWatch or the caller.
    const message = scrubConnectionString((err && err.message) || 'Backfill failed.', databaseUrl);
    console.error('backfill error:', message);
    return { ok: false, applied: false, message };
  }
};

// Exported for unit testing (Lambda only calls .handler).
exports.shouldApply = shouldApply;
