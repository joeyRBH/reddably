# =============================================================================
# LAMBDA - one function per auth handler (register / login / me).
#
# Artifact: the entire /backend folder is zipped by the archive_file data source
# below. You MUST install backend deps first so node_modules is included:
#
#     cd backend && npm install --omit=dev
#
# Then `terraform plan/apply` produces .build/claimsub-backend.zip automatically.
# Neither node_modules nor the zip is committed (.gitignore covers both).
#
# Each function is VPC-attached (private subnets + Lambda SG) and reads
# DATABASE_URL / JWT_SECRET from its environment. Those two values are hydrated
# from SSM by `./deploy.sh` (terraform apply, then a decrypt-and-inject pass) —
# automatically and idempotently, and never written to tfstate. The placeholders
# below let the functions be created; `ignore_changes = [environment]` keeps
# Terraform from reverting the hydrated values on later applies. See README §Secrets.
# =============================================================================

data "archive_file" "backend" {
  type        = "zip"
  source_dir  = "${path.module}/../../backend"
  output_path = "${path.module}/.build/claimsub-backend.zip"

  excludes = [
    ".env",
    ".env.example",
    "README.md",
    ".gitignore",
  ]
}

resource "aws_cloudwatch_log_group" "lambda" {
  for_each = local.lambda_functions

  name              = "/aws/lambda/${local.prefix}-${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn == "" ? null : var.logs_kms_key_arn
}

resource "aws_lambda_function" "auth" {
  for_each = local.lambda_functions

  function_name = "${local.prefix}-${each.key}"
  description   = "Claimsub handler ${each.key}"

  role    = aws_iam_role.lambda_exec.arn
  runtime = var.lambda_runtime
  handler = each.value.handler

  filename         = data.archive_file.backend.output_path
  source_code_hash = data.archive_file.backend.output_base64sha256

  memory_size   = var.lambda_memory_mb
  # A function may override the default timeout in local.lambda_functions
  # (e.g. calendar_sync, which round-trips an external API).
  timeout       = try(each.value.timeout, var.lambda_timeout_seconds)
  architectures = ["arm64"]

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      NODE_ENV       = "production"
      JWT_EXPIRES_IN = "12h"
      # DATABASE_URL / JWT_SECRET / STEDI_API_KEY / FIELD_ENCRYPTION_KEY are
      # hydrated out-of-band from SSM (see README + deploy.sh). Placeholders below
      # let the function be created; ignore_changes preserves the hydrated values
      # on subsequent applies. (Stripe secrets live in Vercel env — the VPC
      # Lambdas make no Stripe calls.)
      DATABASE_URL  = "set-out-of-band-from-ssm"
      JWT_SECRET    = "set-out-of-band-from-ssm"
      STEDI_API_KEY = "set-out-of-band-from-ssm"
      # 32-byte base64/hex key for app-layer field encryption (provider billing
      # TIN). Read by backend/lib/crypto.js in the providers + claims handlers.
      FIELD_ENCRYPTION_KEY = "set-out-of-band-from-ssm"
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.lambda,
    aws_iam_role_policy.lambda_runtime,
    aws_iam_role_policy_attachment.lambda_vpc,
  ]

  lifecycle {
    ignore_changes = [
      # Secrets are injected out-of-band from SSM; don't let Terraform revert them.
      environment,
    ]
  }
}
