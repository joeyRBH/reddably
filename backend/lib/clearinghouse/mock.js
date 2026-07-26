'use strict';

// Deterministic, dependency-free clearinghouse stub. This is the DEFAULT adapter
// (CLEARINGHOUSE unset or 'mock'): it makes no external calls and needs no secrets,
// so the full claim lifecycle is testable end-to-end. It never runs once
// CLEARINGHOUSE=claim_md is configured.
//
//   submitClaim -> 'submitted' with a synthetic control number
//   getStatus   -> 'paid' with illustrative amounts derived from billed_amount

const crypto = require('crypto');

const name = 'mock';

async function submitClaim(ctx) {
  const control = `MOCK-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  const existingNumber = ctx && ctx.claim ? ctx.claim.claim_number : null;
  return {
    control_number: control,
    claim_number: existingNumber || control,
    status: 'submitted',
    raw: { adapter: name, event: 'submit', control_number: control, received: true },
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function getStatus({ control_number, claim }) {
  const billed = claim && claim.billed_amount != null ? Number(claim.billed_amount) : null;
  const allowed = billed != null && Number.isFinite(billed) ? round2(billed * 0.8) : null;
  const reimbursed = billed != null && Number.isFinite(billed) ? round2(billed * 0.6) : null;
  const patientResp = allowed != null && reimbursed != null ? round2(allowed - reimbursed) : null;
  return {
    status: 'paid',
    denial_reason: null,
    allowed_amount: allowed,
    reimbursed_amount: reimbursed,
    patient_responsibility: patientResp,
    raw: { adapter: name, event: 'status', control_number, claim_status: 'paid' },
  };
}

// Reconciliation lookup for a submission whose outcome was never confirmed.
// The mock always "finds" the claim as accepted, so the reconcile flow — adopt
// the clearinghouse's status for a pending claim — is exercisable end-to-end.
async function reconcileSubmission({ patientControlNumber }) {
  const control = `MOCK-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  return {
    found: true,
    status: 'submitted',
    control_number: control,
    raw: {
      adapter: name,
      event: 'reconcile',
      patient_control_number: patientControlNumber || null,
      control_number: control,
    },
  };
}

module.exports = { name, submitClaim, getStatus, reconcileSubmission };
