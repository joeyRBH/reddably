# =============================================================================
# VPC ENDPOINTS - private path for in-VPC Lambdas to reach AWS APIs (no NAT).
#
# The app path has no internet egress (see network.tf): no IGW, no NAT. The
# one-off migrate Lambda (migrate.tf) reads /claimsub/<env>/DATABASE_URL from SSM
# at RUNTIME, which the function ENI cannot otherwise do. An SSM interface
# endpoint (com.amazonaws.<region>.ssm) gives it a private path - still no NAT,
# still no internet. SecureString decryption with the default aws/ssm key is done
# service-side by SSM, so no KMS endpoint is required.
#
# Gated by create_ssm_vpc_endpoint (default false since the NAT gateway - nat.tf -
# gives the Lambda SG a 443 egress path to SSM's public endpoint). Set true to
# recreate a private SSM path if the NAT is ever removed.
# =============================================================================

resource "aws_security_group" "ssm_endpoint" {
  count = var.create_ssm_vpc_endpoint ? 1 : 0

  name        = "${local.prefix}-ssm-endpoint"
  description = "Claimsub SSM interface endpoint - HTTPS from the Lambda SG only."
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.prefix}-ssm-endpoint-sg"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# Endpoint <- Lambda : HTTPS (443) from the Lambda SG only.
resource "aws_vpc_security_group_ingress_rule" "ssm_endpoint_from_lambda" {
  count = var.create_ssm_vpc_endpoint ? 1 : 0

  security_group_id            = aws_security_group.ssm_endpoint[0].id
  description                  = "HTTPS from the Claimsub Lambda SG"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = aws_security_group.lambda.id
}

# Lambda -> Endpoint : HTTPS (443) to the SSM interface endpoint. This is the only
# non-RDS egress the Lambda SG has, and only exists while the endpoint does.
resource "aws_vpc_security_group_egress_rule" "lambda_to_ssm_endpoint" {
  count = var.create_ssm_vpc_endpoint ? 1 : 0

  security_group_id            = aws_security_group.lambda.id
  description                  = "HTTPS to the Claimsub SSM interface endpoint"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = aws_security_group.ssm_endpoint[0].id
}

resource "aws_vpc_endpoint" "ssm" {
  count = var.create_ssm_vpc_endpoint ? 1 : 0

  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${data.aws_region.current.name}.ssm"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.ssm_endpoint[0].id]
  private_dns_enabled = true

  tags = {
    Name = "${local.prefix}-ssm-endpoint"
  }
}
