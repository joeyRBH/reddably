locals {
  prefix = "${var.project_name}-${var.environment}"

  # SSM namespace for this stack's parameters. The Lambda execution role is
  # scoped to exactly this path (see iam.tf).
  ssm_path_prefix = "/${var.project_name}/${var.environment}"

  # Two private subnets, one per AZ (first two AZs in the region).
  azs = slice(data.aws_availability_zones.available.names, 0, 2)

  # The API surface: one Lambda per handler. A handler may serve more than one
  # route (method + path) — e.g. the clients resource is a single Lambda routed
  # internally by method and the presence of an {id} path parameter.
  # `handler` matches backend/handlers/<name>.handler (the zip root is /backend).
  lambda_functions = {
    register = {
      handler = "handlers/register.handler"
      routes  = [{ method = "POST", path = "register" }]
    }
    login = {
      handler = "handlers/login.handler"
      routes  = [{ method = "POST", path = "login" }]
    }
    me = {
      handler = "handlers/me.handler"
      routes  = [{ method = "GET", path = "me" }]
    }
    practice = {
      handler = "handlers/practice.handler"
      # The caller's own practice: settings summary (GET) + identity/billing-address
      # edit (PUT; PATCH accepted as an alias). Billing address feeds Stedi 837P.
      routes = [
        { method = "GET", path = "practice" },
        { method = "PUT", path = "practice" },
        { method = "PATCH", path = "practice" },
      ]
    }
    clients = {
      handler = "handlers/clients.handler"
      routes = [
        { method = "POST", path = "clients" },
        { method = "GET", path = "clients" },
        { method = "GET", path = "clients/{id}" },
        { method = "PATCH", path = "clients/{id}" },
        { method = "DELETE", path = "clients/{id}" },
      ]
    }
    insurance_records = {
      handler = "handlers/insurance_records.handler"
      routes = [
        { method = "POST", path = "insurance-records" },
        { method = "GET", path = "insurance-records" },
        { method = "GET", path = "insurance-records/{id}" },
        { method = "PATCH", path = "insurance-records/{id}" },
        { method = "DELETE", path = "insurance-records/{id}" },
      ]
    }
    sessions = {
      handler = "handlers/sessions.handler"
      routes = [
        { method = "POST", path = "sessions" },
        { method = "GET", path = "sessions" },
        { method = "GET", path = "sessions/{id}" },
        { method = "PATCH", path = "sessions/{id}" },
        { method = "DELETE", path = "sessions/{id}" },
      ]
    }
    claims = {
      handler = "handlers/claims.handler"
      routes = [
        { method = "POST", path = "claims" },
        { method = "GET", path = "claims" },
        { method = "GET", path = "claims/{id}" },
        { method = "PATCH", path = "claims/{id}" },
        { method = "DELETE", path = "claims/{id}" },
        { method = "POST", path = "claims/{id}/submit" },
        { method = "POST", path = "claims/{id}/refresh" },
        { method = "POST", path = "claims/{id}/void" },
        { method = "POST", path = "claims/{id}/regenerate" },
        { method = "GET", path = "claims/{id}/events" },
      ]
    }
    refund_requests = {
      handler = "handlers/refund_requests.handler"
      # Patient-initiated fee-refund flow (admin only; the handler 403s non-admins).
      # A PAID/DEDUCTIBLE claim is a success — only a DENIAL refunds the 5% fee. The
      # approve/context + approve/record pair is driven by the Vercel adapter
      # (api/refund-requests/[id]/approve.js), which owns the Stripe egress the VPC lacks.
      routes = [
        { method = "POST", path = "refund-requests" },
        { method = "GET", path = "refund-requests" },
        { method = "GET", path = "refund-requests/{id}" },
        { method = "POST", path = "refund-requests/{id}/deny" },
        { method = "POST", path = "refund-requests/{id}/approve/context" },
        { method = "POST", path = "refund-requests/{id}/approve/record" },
      ]
    }
    users = {
      handler = "handlers/users.handler"
      routes = [
        { method = "GET", path = "users" },
        { method = "GET", path = "users/{id}" },
        { method = "PATCH", path = "users/{id}" },
      ]
    }
    reports = {
      handler = "handlers/reports.handler"
      # Practice analytics v1: server-side aggregation (pipeline / revenue / aging
      # / by-client / by-CPT) over the caller's practice claims. Practice-scoped
      # from the token; optional ?start & ?end (YYYY-MM-DD) date-range filter.
      routes = [
        { method = "GET", path = "reports" },
      ]
    }
    audit = {
      handler = "handlers/audit.handler"
      # HIPAA audit-log read endpoint (45 CFR 164.312(b)). Practice-scoped from the
      # token; ADMIN ONLY (403 otherwise). Read-only — the log is append-only and
      # written by lib/audit.js inside the other handlers. Filters: from/to/action/
      # resource_type/resource_id/actor_user_id/limit/before.
      routes = [
        { method = "GET", path = "audit-log" },
      ]
    }
    invitations = {
      handler = "handlers/invitations.handler"
      routes = [
        { method = "POST", path = "invitations" },
        { method = "GET", path = "invitations" },
        { method = "DELETE", path = "invitations/{id}" },
      ]
    }
    calendar = {
      handler = "handlers/calendar.handler"
      # De-identified, read-only ICS feed per clinician (ZERO PHI leaves Reddably).
      # The .ics feed authenticates by the opaque feed_token in the path (calendar
      # apps can't send a JWT); the literal /settings and /regenerate routes are
      # Bearer-JWT authed and are more specific than the {feed_token} variable, so
      # API Gateway routes them first. NOTE: API Gateway cannot place a literal
      # ".ics" after a path variable, so the feed route captures "{feed_token}" as
      # "<token>.ics" and the handler strips the suffix.
      routes = [
        { method = "GET", path = "calendar/settings" },
        { method = "POST", path = "calendar/regenerate" },
        { method = "GET", path = "calendar/{feed_token}" },
      ]
    }
    calendar_oauth = {
      handler = "handlers/calendar_oauth.handler"
      # INBOUND Google Calendar sync — OAuth connect/disconnect only (no event
      # fetching yet). /callback is reached by a browser redirect from Google
      # (proxied through the app domain via vercel.json) and authenticates by
      # the signed short-lived `state` from /start, not a Bearer header.
      # Refresh tokens live in SSM SecureStrings keyed by connection id — see
      # iam.tf's SSMWriteGoogleRefreshTokens grant.
      routes = [
        { method = "GET", path = "integrations/google/start" },
        { method = "GET", path = "integrations/google/callback" },
        { method = "GET", path = "integrations/google/status" },
        { method = "POST", path = "integrations/google/disconnect" },
      ]
    }
    vob = {
      handler = "handlers/vob.handler"
      routes = [
        { method = "POST", path = "vob/check" },
      ]
    }
    payers = {
      handler = "handlers/payers.handler"
      # Read-only type-ahead payer lookup backed by Stedi's Search Payers API.
      # No PHI: the only input is a free-text payer-name fragment.
      routes = [
        { method = "GET", path = "payers/search" },
      ]
    }
    providers = {
      handler = "handlers/providers.handler"
      # Provider billing identity: NPPES NPI verification (public registry data,
      # no PHI) + the per-clinician billing profile the 837P builder reads. The
      # billing profile carries a sensitive TIN (app-layer encrypted); routes are
      # practice-scoped and role-gated in the handler.
      routes = [
        { method = "POST", path = "providers/verify-npi" },
        { method = "GET", path = "providers/{userId}/billing-profile" },
        { method = "PUT", path = "providers/{userId}/billing-profile" },
      ]
    }
    payer_enrollments = {
      handler = "handlers/payer_enrollments.handler"
      # Per-practice ERA (electronic remittance) enrollments. List refreshes stale
      # non-terminal rows from the clearinghouse (and imports ones created outside
      # the app); create is practice_admin-only; sync forces a single-row refresh.
      routes = [
        { method = "GET", path = "payer-enrollments" },
        { method = "POST", path = "payer-enrollments" },
        { method = "POST", path = "payer-enrollments/{id}/sync" },
      ]
    }
    subscription = {
      handler = "handlers/subscription.handler"
      # DB-only status route stays on the Lambda API. The Stripe-facing
      # /subscription/vob/activate lives on Vercel (api/vob-activate.js) — the VPC
      # Lambdas have no NAT egress to Stripe.
      routes = [
        { method = "GET", path = "subscription/status" },
      ]
    }

    # ── DB side of the /api Vercel functions ──────────────────────────────────
    # The Vercel functions have outbound egress (Stripe/Twilio) but cannot reach
    # the VPC-private RDS. These VPC Lambdas own the DB access; the Vercel adapters
    # call them over HTTPS and keep only the third-party call. See the handlers.
    card_setup = {
      handler = "handlers/card_setup.handler"
      routes = [
        { method = "POST", path = "card-setup/context" },
        { method = "POST", path = "card-setup/save-customer" },
        { method = "POST", path = "card-setup/save-payment-method" },
        { method = "POST", path = "card-setup/save-details" },
        { method = "POST", path = "card-setup/save-insurance" },
        { method = "POST", path = "card-setup/payer-search" },
      ]
    }
    payment_link = {
      handler = "handlers/payment_link.handler"
      routes = [
        { method = "POST", path = "clients/{id}/payment-link" },
      ]
    }
    claim_fee = {
      handler = "handlers/claim_fee.handler"
      routes = [
        { method = "POST", path = "claims/{id}/charge-fee/context" },
        { method = "POST", path = "claims/{id}/charge-fee/record" },
      ]
    }
    vob_billing = {
      handler = "handlers/vob_billing.handler"
      # checkout-context is staff-authed (called by api/vob-activate.js); webhook is
      # Stripe-signature-authed and fully replaces api/vob-webhook.js (no egress needed).
      routes = [
        { method = "POST", path = "subscription/vob/checkout-context" },
        { method = "POST", path = "subscription/vob/webhook" },
      ]
    }
  }

  # Flatten lambda_functions into one entry per (function, route) pair, keyed by a
  # sanitized string. Routes/integration permissions for_each over this map.
  api_routes = merge([
    for fname, fn in local.lambda_functions : {
      for r in fn.routes :
      "${fname}-${r.method}-${replace(replace(replace(r.path, "/", "-"), "{", ""), "}", "")}" => {
        function = fname
        method   = r.method
        path     = r.path
      }
    }
  ]...)

  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
    Stack       = "claimsub-backend"
    HIPAA       = "true"
  }
}
