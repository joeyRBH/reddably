# =============================================================================
# BACKFILL - one-off claim-backfill Lambda (claimsub-<env>-backfill-claim-fields).
#
# Runs backend/scripts/backfill-claim-derived-fields.js from inside the VPC. RDS
# is publicly_accessible = false and there is no bastion, so this is the only way
# an operator can run it against the real database (same reasoning as migrate.tf,
# see README §Apply the database schema).
#
# It is deliberately shaped like migrate: same role, same private subnets, same
# Lambda SG, DATABASE_URL read from SSM at RUNTIME so there is no out-of-band env
# hydration and no ignore_changes on environment.
#
# TWO DIFFERENCES FROM MIGRATE, BOTH ON PURPOSE:
#
#   * deploy.sh does NOT invoke this. migrate runs on every deploy because
#     applying an idempotent schema is safe; this one CHANGES CLAIM DATA and must
#     never run as a side effect of shipping code. An operator invokes it by hand.
#   * It is dry-run by default. A bare invoke makes NO writes and returns the
#     summary; only a payload of exactly {"apply": true} writes.
#
#   # dry run:
#   aws lambda invoke --function-name $(terraform output -raw backfill_claim_fields_function_name) \
#     /tmp/backfill.json && cat /tmp/backfill.json
#
#   # apply (after reading the dry-run summary):
#   aws lambda invoke --function-name $(terraform output -raw backfill_claim_fields_function_name) \
#     --payload '{"apply":true}' --cli-binary-format raw-in-base64-out \
#     /tmp/backfill.json && cat /tmp/backfill.json
#
# The handler ships in the same backend zip as every other function (archive_file
# .backend in lambda.tf covers backend/ wholesale), so there is no extra build
# step. Timeout is 60s like migrate — it is invoked directly, never through API
# Gateway's 29s integration limit.
#
# Once the backfill has been applied and verified, this function can be destroyed
# (`terraform destroy -target=aws_lambda_function.backfill_claim_fields`); the
# script stays in the repo and the whole thing can be recreated by re-applying.
# =============================================================================

resource "aws_cloudwatch_log_group" "backfill_claim_fields" {
  name              = "/aws/lambda/${local.prefix}-backfill-claim-fields"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn == "" ? null : var.logs_kms_key_arn
}

resource "aws_lambda_function" "backfill_claim_fields" {
  function_name = "${local.prefix}-backfill-claim-fields"
  description   = "Claimsub one-off claim backfill: re-derives insurance_record_id + billed_amount on draft/denied claims. Dry-run unless invoked with {apply:true}."

  role    = aws_iam_role.lambda_exec.arn
  runtime = var.lambda_runtime
  handler = "handlers/backfill_claim_fields.handler"

  filename         = data.archive_file.backend.output_path
  source_code_hash = data.archive_file.backend.output_base64sha256

  memory_size   = var.lambda_memory_mb
  timeout       = 60
  architectures = ["arm64"]

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      NODE_ENV = "production"
      # Name of the SecureString to read at runtime. Not a secret; the value is
      # fetched via SSM and never stored in the function config.
      DATABASE_URL_SSM_PARAM = "${local.ssm_path_prefix}/DATABASE_URL"
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.backfill_claim_fields,
    aws_iam_role_policy.lambda_runtime,
    aws_iam_role_policy_attachment.lambda_vpc,
  ]
}
