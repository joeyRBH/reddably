# ─────────────────────────────────────────────────────────────
# Network
# ─────────────────────────────────────────────────────────────

output "vpc_id" {
  description = "Dedicated Claimsub VPC ID."
  value       = aws_vpc.main.id
}

output "private_subnet_ids" {
  description = "Private subnet IDs hosting RDS and the Lambdas."
  value       = aws_subnet.private[*].id
}

output "lambda_security_group_id" {
  description = "Security group attached to the auth Lambdas."
  value       = aws_security_group.lambda.id
}

output "rds_security_group_id" {
  description = "Security group attached to RDS (ingress 5432 from the Lambda SG only)."
  value       = aws_security_group.rds.id
}

# ─────────────────────────────────────────────────────────────
# Database
# ─────────────────────────────────────────────────────────────

output "db_endpoint" {
  description = "RDS endpoint (host:port). Use to assemble DATABASE_URL out-of-band."
  value       = aws_db_instance.main.endpoint
}

output "db_address" {
  description = "RDS hostname."
  value       = aws_db_instance.main.address
}

output "db_name" {
  description = "Initial database name."
  value       = aws_db_instance.main.db_name
}

# ─────────────────────────────────────────────────────────────
# Lambda
# ─────────────────────────────────────────────────────────────

output "lambda_function_names" {
  description = "Map of handler key → Lambda function name."
  value       = { for k, fn in aws_lambda_function.auth : k => fn.function_name }
}

output "lambda_function_arns" {
  description = "Map of handler key → Lambda ARN."
  value       = { for k, fn in aws_lambda_function.auth : k => fn.arn }
}

output "lambda_exec_role_arn" {
  description = "Lambda execution role ARN."
  value       = aws_iam_role.lambda_exec.arn
}

output "migrate_function_name" {
  description = "Name of the one-off schema-migration Lambda (invoked by deploy.sh after apply)."
  value       = aws_lambda_function.migrate.function_name
}

output "backfill_claim_fields_function_name" {
  description = "Name of the one-off claim-backfill Lambda. Operator-invoked only — deploy.sh never calls it. Dry-run unless invoked with {\"apply\": true}."
  value       = aws_lambda_function.backfill_claim_fields.function_name
}

# ─────────────────────────────────────────────────────────────
# API
# ─────────────────────────────────────────────────────────────

output "api_id" {
  description = "HTTP API (v2) ID."
  value       = aws_apigatewayv2_api.http.id
}

output "api_endpoint" {
  description = "Default HTTPS endpoint for the HTTP API. Use to smoke-test before the custom domain is live."
  value       = aws_apigatewayv2_api.http.api_endpoint
}

# ─────────────────────────────────────────────────────────────
# SSM
# ─────────────────────────────────────────────────────────────

output "ssm_secure_parameter_names" {
  description = "Names of the SecureString parameters whose values must be set out-of-band."
  value       = [for p in aws_ssm_parameter.secure : p.name]
}

# ─────────────────────────────────────────────────────────────
# Custom domain (ACM + API Gateway)
# ─────────────────────────────────────────────────────────────

output "acm_certificate_arn" {
  description = "ARN of the requested ACM certificate for api.claimsub.com."
  value       = aws_acm_certificate.api.arn
}

output "acm_validation_records" {
  description = "DNS records to add MANUALLY at the DNS provider to validate the ACM cert (name/type/value)."
  value = [
    for dvo in aws_acm_certificate.api.domain_validation_options : {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  ]
}

output "api_custom_domain_target" {
  description = "Regional API Gateway hostname to point api.claimsub.com at (CNAME/ALIAS). Null until create_api_custom_domain = true (Phase 2)."
  value       = var.create_api_custom_domain ? aws_apigatewayv2_domain_name.api[0].domain_name_configuration[0].target_domain_name : null
}

output "api_custom_domain_hosted_zone_id" {
  description = "Hosted zone ID of the API Gateway regional endpoint (for a Route53 ALIAS record). Null until Phase 2."
  value       = var.create_api_custom_domain ? aws_apigatewayv2_domain_name.api[0].domain_name_configuration[0].hosted_zone_id : null
}

# ─────────────────────────────────────────────────────────────
# Reddably custom domain (ACM + API Gateway)
# ─────────────────────────────────────────────────────────────

output "acm_certificate_arn_reddably" {
  description = "ARN of the requested ACM certificate for api.reddably.com."
  value       = aws_acm_certificate.api_reddably.arn
}

output "acm_validation_records_reddably" {
  description = "DNS records to add MANUALLY at the DNS provider to validate the Reddably ACM cert (name/type/value)."
  value = [
    for dvo in aws_acm_certificate.api_reddably.domain_validation_options : {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  ]
}

output "api_custom_domain_target_reddably" {
  description = "Regional API Gateway hostname to point api.reddably.com at (CNAME/ALIAS). Null until create_api_custom_domain = true (Phase 2)."
  value       = var.create_api_custom_domain ? aws_apigatewayv2_domain_name.api_reddably[0].domain_name_configuration[0].target_domain_name : null
}

output "api_custom_domain_hosted_zone_id_reddably" {
  description = "Hosted zone ID of the Reddably API Gateway regional endpoint (for a Route53 ALIAS record). Null until Phase 2."
  value       = var.create_api_custom_domain ? aws_apigatewayv2_domain_name.api_reddably[0].domain_name_configuration[0].hosted_zone_id : null
}

# ─────────────────────────────────────────────────────────────
# Sessionably Claims custom domain (ACM + API Gateway)
# ─────────────────────────────────────────────────────────────

output "acm_certificate_arn_sessionably" {
  description = "ARN of the requested ACM certificate for api.claims.sessionably.com."
  value       = aws_acm_certificate.api_sessionably.arn
}

output "acm_validation_records_sessionably" {
  description = "DNS records to add MANUALLY at the DNS provider to validate the Sessionably Claims ACM cert (name/type/value)."
  value = [
    for dvo in aws_acm_certificate.api_sessionably.domain_validation_options : {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  ]
}

output "api_custom_domain_target_sessionably" {
  description = "Regional API Gateway hostname to point api.claims.sessionably.com at (CNAME/ALIAS). Null until create_api_custom_domain = true (Phase 2)."
  value       = var.create_api_custom_domain ? aws_apigatewayv2_domain_name.api_sessionably[0].domain_name_configuration[0].target_domain_name : null
}

output "api_custom_domain_hosted_zone_id_sessionably" {
  description = "Hosted zone ID of the Sessionably Claims API Gateway regional endpoint (for a Route53 ALIAS record). Null until Phase 2."
  value       = var.create_api_custom_domain ? aws_apigatewayv2_domain_name.api_sessionably[0].domain_name_configuration[0].hosted_zone_id : null
}

# ─────────────────────────────────────────────────────────────
# SES (transactional email)
# ─────────────────────────────────────────────────────────────

output "ses_from_address" {
  description = "FROM address the backend sends notifications from. Must be on ses_domain and covered by the verified identity."
  value       = var.ses_from_address
}

output "ses_domain_verification_record" {
  description = "TXT record to add at the DNS provider to verify the SES domain identity (name/type/value)."
  value = {
    name  = "_amazonses.${aws_ses_domain_identity.reddably.domain}"
    type  = "TXT"
    value = aws_ses_domain_identity.reddably.verification_token
  }
}

output "ses_dkim_records" {
  description = "Three CNAME records to add at the DNS provider for SES Easy DKIM (name/type/value). Email will not send until these (and the verification TXT) resolve."
  value = [
    for token in aws_ses_domain_dkim.reddably.dkim_tokens : {
      name  = "${token}._domainkey.${aws_ses_domain_identity.reddably.domain}"
      type  = "CNAME"
      value = "${token}.dkim.amazonses.com"
    }
  ]
}

# ─────────────────────────────────────────────────────────────
# SES (Sessionably Claims — the active sender domain)
# ─────────────────────────────────────────────────────────────

output "ses_domain_verification_record_sessionably" {
  description = "TXT record to add at the DNS provider to verify the Sessionably Claims SES domain identity (name/type/value)."
  value = {
    name  = "_amazonses.${aws_ses_domain_identity.sessionably.domain}"
    type  = "TXT"
    value = aws_ses_domain_identity.sessionably.verification_token
  }
}

output "ses_dkim_records_sessionably" {
  description = "Three CNAME records to add at the DNS provider for Sessionably Claims SES Easy DKIM (name/type/value). Email will not send from notifications@claims.sessionably.com until these (and the verification TXT) resolve."
  value = [
    for token in aws_ses_domain_dkim.sessionably.dkim_tokens : {
      name  = "${token}._domainkey.${aws_ses_domain_identity.sessionably.domain}"
      type  = "CNAME"
      value = "${token}.dkim.amazonses.com"
    }
  ]
}

# ─────────────────────────────────────────────────────────────
# Aggregate: every DNS record Joey must create for the Sessionably
# Claims brand (SES identity + DKIM, ACM validation, API endpoint).
# Copy-paste ready. The api_endpoint entry is null until Phase 2
# (create_api_custom_domain = true), matching the per-record outputs above.
# ─────────────────────────────────────────────────────────────

output "claims_dns_records" {
  description = "All DNS records to create at the DNS provider for claims.sessionably.com + api.claims.sessionably.com: SES verification TXT, 3 SES DKIM CNAMEs, ACM validation CNAME(s), and the final API endpoint CNAME target (null until Phase 2)."
  value = {
    ses_verification_txt = {
      name  = "_amazonses.${aws_ses_domain_identity.sessionably.domain}"
      type  = "TXT"
      value = aws_ses_domain_identity.sessionably.verification_token
    }
    ses_dkim_cnames = [
      for token in aws_ses_domain_dkim.sessionably.dkim_tokens : {
        name  = "${token}._domainkey.${aws_ses_domain_identity.sessionably.domain}"
        type  = "CNAME"
        value = "${token}.dkim.amazonses.com"
      }
    ]
    acm_validation_cnames = [
      for dvo in aws_acm_certificate.api_sessionably.domain_validation_options : {
        name  = dvo.resource_record_name
        type  = dvo.resource_record_type
        value = dvo.resource_record_value
      }
    ]
    api_endpoint_cname = var.create_api_custom_domain ? {
      name  = var.api_domain_name_sessionably
      type  = "CNAME"
      value = aws_apigatewayv2_domain_name.api_sessionably[0].domain_name_configuration[0].target_domain_name
    } : null
  }
}

# ─────────────────────────────────────────────────────────────
# NAT egress (Stedi clearinghouse)
# ─────────────────────────────────────────────────────────────

output "nat_gateway_public_ip" {
  description = "Public egress IP (NAT Elastic IP) the in-VPC Lambdas present to Stedi and other HTTPS APIs. Null when enable_nat_gateway = false."
  value       = var.enable_nat_gateway ? aws_eip.nat[0].public_ip : null
}
