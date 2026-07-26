'use strict';

// Swappable clearinghouse adapter. The active adapter is chosen by the
// CLEARINGHOUSE env var (default 'mock'). Adapters share one interface:
//
//   name                         string identifier stored on claims.clearinghouse
//   async submitClaim(ctx)    -> { control_number, claim_number, status, raw }
//   async getStatus({ control_number, claim })
//                             -> { status, denial_reason?, allowed_amount?,
//                                  reimbursed_amount?, patient_responsibility?, raw }
//   async reconcileSubmission({ ctx, patientControlNumber })   (optional)
//                             -> { found: true, status, control_number?, raw }
//                                | { found: false, raw }
//     Look up a submission whose outcome was never confirmed, matching on the
//     patient control number that was transmitted. Adapters that can't do this
//     (claim_md) simply don't export it; the handler then requires an explicit
//     operator resolution instead.
//
// `ctx` is a normalized object the handler assembles (claim/session/client/
// insurance/clinician/practice) so adapters never touch the DB.

const mock = require('./mock');
const claimMd = require('./claim_md');
const stedi = require('./stedi');

const ADAPTERS = {
  mock,
  claim_md: claimMd,
};
ADAPTERS['stedi'] = stedi;

function getClearinghouse() {
  const name = String(process.env.CLEARINGHOUSE || 'mock').toLowerCase();
  const adapter = ADAPTERS[name];
  if (!adapter) {
    throw new Error(`Unknown clearinghouse adapter: ${name}`);
  }
  return adapter;
}

module.exports = { getClearinghouse };
