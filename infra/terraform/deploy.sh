#!/usr/bin/env bash
set -euo pipefail

# Claimsub deploy: terraform apply, then hydrate every Lambda's DATABASE_URL and
# JWT_SECRET from SSM (SecureString, decrypted) WITHOUT writing them to tfstate.
# Secrets live only in SSM and each function's env config. Run from infra/terraform
# on a machine with the claimsub-prod profile (or set AWS_PROFILE/AWS_REGION).

cd "$(dirname "$0")"

command -v jq >/dev/null 2>&1 || { echo "jq is required (brew install jq)"; exit 2; }

# Install backend runtime deps from the committed lockfile. archive_file zips
# backend/ verbatim, so whatever node_modules holds right now IS the prod
# artifact — a fresh clone has none, and deploying from one shipped
# dependency-less zips that 500'd every Lambda at cold start (prod outage,
# 2026-08-03). `npm ci` is reproducible (exact lockfile versions, clean
# node_modules); lambda.tf additionally refuses to plan if this step was
# skipped or node_modules drifted from the lockfile.
echo ">> installing backend deps (npm ci --omit=dev)"
( cd ../../backend && npm ci --omit=dev --no-audit --no-fund )

# Refresh the schema bundle the migrate Lambda ships (db/schema.sql is the single
# source of truth; backend/sql/schema.sql is gitignored and regenerated). Running
# it here means a schema change can never silently deploy a stale copy. Pure fs
# copy — no external deps.
echo ">> bundling schema (db/schema.sql -> backend/sql/schema.sql)"
( cd ../../backend && npm run --silent bundle:schema )

PROFILE="${AWS_PROFILE:-claimsub-prod}"
REGION="${AWS_REGION:-us-west-2}"
AWS=(aws --profile "$PROFILE" --region "$REGION")

echo ">> terraform apply"
terraform apply "$@"

echo ">> reading terraform outputs"
FUNCS=$(terraform output -json lambda_function_names | jq -r '.[]')
DB_PARAM=$(terraform output -json ssm_secure_parameter_names | jq -r '.[] | select(endswith("/DATABASE_URL"))')
JWT_PARAM=$(terraform output -json ssm_secure_parameter_names | jq -r '.[] | select(endswith("/JWT_SECRET"))')

echo ">> fetching secrets from SSM (decrypted)"
DB_VAL=$("${AWS[@]}" ssm get-parameter --name "$DB_PARAM" --with-decryption --query 'Parameter.Value' --output text)
JWT_VAL=$("${AWS[@]}" ssm get-parameter --name "$JWT_PARAM" --with-decryption --query 'Parameter.Value' --output text)

case "$DB_VAL" in ""|"set-out-of-band-see-README") echo "ERROR: DATABASE_URL not set in SSM yet."; exit 1;; esac
case "$JWT_VAL" in ""|"set-out-of-band-see-README") echo "ERROR: JWT_SECRET not set in SSM yet."; exit 1;; esac

# Optional secret: hydrated only when its SSM parameter exists AND holds a real
# value (not the placeholder). Missing/placeholder → left as-is, so a stack without
# Stedi configured still deploys. (Stripe secrets live in Vercel env, not here.)
fetch_optional() {
  # $1 = parameter-name suffix (e.g. /STEDI_API_KEY)
  local PARAM VAL
  PARAM=$(terraform output -json ssm_secure_parameter_names | jq -r --arg s "$1" '.[] | select(endswith($s))')
  [ -z "$PARAM" ] && { printf ''; return; }
  VAL=$("${AWS[@]}" ssm get-parameter --name "$PARAM" --with-decryption --query 'Parameter.Value' --output text 2>/dev/null || printf '')
  case "$VAL" in ""|"set-out-of-band-see-README"|"set-out-of-band-from-ssm") printf '';; *) printf '%s' "$VAL";; esac
}

# Same as fetch_optional but addressed by FULL parameter name rather than by the
# terraform-managed ssm_secure_parameter_names output. Used for CLEARINGHOUSE, a
# non-secret config value set out-of-band in SSM but NOT declared as a terraform
# placeholder param (see the CLEARINGHOUSE fetch below).
fetch_optional_name() {
  # $1 = full SSM parameter name (e.g. /claimsub/prod/CLEARINGHOUSE)
  local VAL
  VAL=$("${AWS[@]}" ssm get-parameter --name "$1" --with-decryption --query 'Parameter.Value' --output text 2>/dev/null || printf '')
  case "$VAL" in ""|"set-out-of-band-see-README"|"set-out-of-band-from-ssm") printf '';; *) printf '%s' "$VAL";; esac
}

STEDI_VAL=$(fetch_optional "/STEDI_API_KEY")
[ -n "$STEDI_VAL" ] && echo ">> STEDI_API_KEY present in SSM; will hydrate" || echo ">> STEDI_API_KEY not set in SSM; skipping"

WEBHOOK_VAL=$(fetch_optional "/STRIPE_VOB_WEBHOOK_SECRET")
[ -n "$WEBHOOK_VAL" ] && echo ">> STRIPE_VOB_WEBHOOK_SECRET present in SSM; will hydrate" || echo ">> STRIPE_VOB_WEBHOOK_SECRET not set in SSM; skipping (vob_billing webhook will reject until set)"

FIELD_KEY_VAL=$(fetch_optional "/FIELD_ENCRYPTION_KEY")
[ -n "$FIELD_KEY_VAL" ] && echo ">> FIELD_ENCRYPTION_KEY present in SSM; will hydrate" || echo ">> FIELD_ENCRYPTION_KEY not set in SSM; skipping (billing-profile TIN saves will fail until set)"

# CLEARINGHOUSE selects the claims adapter (backend/lib/clearinghouse/index.js);
# absent → the code defaults to the 'mock' adapter, so prod must carry the real
# value. It is a plain (non-secret) config param set out-of-band in SSM under the
# same path prefix as the secrets — e.g. /claimsub/prod/CLEARINGHOUSE = "stedi".
# It is intentionally NOT a terraform-managed placeholder param (see PR notes), so
# derive the SSM path prefix from the DATABASE_URL param we already resolved and
# address CLEARINGHOUSE by full name. Hydrated into every handler Lambda uniformly,
# exactly like the secret values below.
SSM_PREFIX="${DB_PARAM%/DATABASE_URL}"
CLEARINGHOUSE_VAL=$(fetch_optional_name "$SSM_PREFIX/CLEARINGHOUSE")
[ -n "$CLEARINGHOUSE_VAL" ] && echo ">> CLEARINGHOUSE present in SSM (=$CLEARINGHOUSE_VAL); will hydrate" || echo ">> CLEARINGHOUSE not set in SSM; skipping (handlers fall back to the 'mock' adapter)"

for FN in $FUNCS; do
  "${AWS[@]}" lambda wait function-updated --function-name "$FN"
  CUR=$("${AWS[@]}" lambda get-function-configuration --function-name "$FN" --query 'Environment.Variables' --output json)
  if [ -z "$CUR" ] || [ "$CUR" = "null" ]; then CUR='{}'; fi
  CUR_DB=$(printf '%s' "$CUR" | jq -r '.DATABASE_URL // ""')
  CUR_JWT=$(printf '%s' "$CUR" | jq -r '.JWT_SECRET // ""')
  CUR_STEDI=$(printf '%s' "$CUR" | jq -r '.STEDI_API_KEY // ""')
  CUR_WEBHOOK=$(printf '%s' "$CUR" | jq -r '.STRIPE_VOB_WEBHOOK_SECRET // ""')
  CUR_CLEARINGHOUSE=$(printf '%s' "$CUR" | jq -r '.CLEARINGHOUSE // ""')
  CUR_FIELD_KEY=$(printf '%s' "$CUR" | jq -r '.FIELD_ENCRYPTION_KEY // ""')
  if [ "$CUR_DB" = "$DB_VAL" ] && [ "$CUR_JWT" = "$JWT_VAL" ] \
     && { [ -z "$STEDI_VAL" ] || [ "$CUR_STEDI" = "$STEDI_VAL" ]; } \
     && { [ -z "$WEBHOOK_VAL" ] || [ "$CUR_WEBHOOK" = "$WEBHOOK_VAL" ]; } \
     && { [ -z "$CLEARINGHOUSE_VAL" ] || [ "$CUR_CLEARINGHOUSE" = "$CLEARINGHOUSE_VAL" ]; } \
     && { [ -z "$FIELD_KEY_VAL" ] || [ "$CUR_FIELD_KEY" = "$FIELD_KEY_VAL" ]; }; then
    echo ">> $FN already hydrated, skipping"
    continue
  fi
  echo ">> hydrating $FN"
  # Merge db/jwt (required) plus stedi + stripe webhook + clearinghouse + field
  # encryption key only when we have real values.
  ENVJSON=$(printf '%s' "$CUR" | jq \
    --arg db "$DB_VAL" --arg jwt "$JWT_VAL" --arg stedi "$STEDI_VAL" --arg webhook "$WEBHOOK_VAL" --arg clearinghouse "$CLEARINGHOUSE_VAL" --arg fieldkey "$FIELD_KEY_VAL" '
      (. + {DATABASE_URL:$db, JWT_SECRET:$jwt})
      | (if $stedi != "" then . + {STEDI_API_KEY:$stedi} else . end)
      | (if $webhook != "" then . + {STRIPE_VOB_WEBHOOK_SECRET:$webhook} else . end)
      | (if $clearinghouse != "" then . + {CLEARINGHOUSE:$clearinghouse} else . end)
      | (if $fieldkey != "" then . + {FIELD_ENCRYPTION_KEY:$fieldkey} else . end)
      | {Variables: .}')
  TMP=$(mktemp)
  printf '%s' "$ENVJSON" > "$TMP"
  "${AWS[@]}" lambda update-function-configuration --function-name "$FN" --environment "file://$TMP" >/dev/null
  rm -f "$TMP"
  "${AWS[@]}" lambda wait function-updated --function-name "$FN"
done

# ---------------------------------------------------------------------------
# Run database migrations.
#
# terraform apply ships the new handler code, but the migrate Lambda applies
# db/schema.sql to RDS and is NOT invoked by terraform. Skipping it has twice
# caused prod failures where freshly deployed code referenced columns that did
# not exist yet (practice billing address; patient_control_number). schema.sql
# is idempotent, so this is safe to run on every deploy. We fail loudly (non-zero
# exit) if the migration reports an error or the invoke itself fails, so a bad
# migration can never masquerade as a clean deploy.
# ---------------------------------------------------------------------------
echo ">> running database migrations (invoking migrate Lambda)"
MIGRATE_FN=$(terraform output -raw migrate_function_name)
"${AWS[@]}" lambda wait function-updated --function-name "$MIGRATE_FN"

MIG_OUT=$(mktemp)
# --cli-binary-format raw-in-base64-out lets us pass a plain-JSON payload on AWS
# CLI v2. The function's return value is written to $MIG_OUT; invoke metadata
# (StatusCode / FunctionError) comes back as JSON on stdout.
MIG_META=$("${AWS[@]}" lambda invoke \
  --function-name "$MIGRATE_FN" \
  --cli-binary-format raw-in-base64-out \
  --payload '{}' \
  --output json \
  "$MIG_OUT") || { echo "ERROR: migrate Lambda invoke failed to execute."; rm -f "$MIG_OUT"; exit 1; }

MIG_FN_ERROR=$(printf '%s' "$MIG_META" | jq -r '.FunctionError // ""')
MIG_BODY=$(cat "$MIG_OUT")
rm -f "$MIG_OUT"
MIG_OK=$(printf '%s' "$MIG_BODY" | jq -r 'if type=="object" then (.ok // empty) else empty end' 2>/dev/null || printf '')
MIG_MSG=$(printf '%s' "$MIG_BODY" | jq -r 'if type=="object" then (.message // "") else "" end' 2>/dev/null || printf '')

if [ -n "$MIG_FN_ERROR" ] || [ "$MIG_OK" != "true" ]; then
  echo "!! MIGRATION FAILED"
  [ -n "$MIG_FN_ERROR" ] && echo "!!   FunctionError: $MIG_FN_ERROR"
  [ -n "$MIG_MSG" ] && echo "!!   message: $MIG_MSG"
  echo "!!   raw response: $MIG_BODY"
  exit 1
fi
echo ">> MIGRATION OK: ${MIG_MSG:-schema applied}"

echo ">> done. Secrets hydrated from SSM; migrations applied; tfstate contains no secret values."
