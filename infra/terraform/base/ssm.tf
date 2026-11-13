# Las AMIs ya incluyen el software. El primer arranque privado solo necesita
# consultar Parameter Store; este endpoint no proporciona salida a Internet.
resource "aws_security_group" "ssm" {
  name_prefix = "${var.project_name}-ssm-"
  description = "HTTPS privado hacia Parameter Store"
  vpc_id      = aws_vpc.platform.id

  tags = { Name = "${var.project_name}-ssm", Role = "ssm-endpoint" }
}

resource "aws_vpc_security_group_ingress_rule" "ssm" {
  security_group_id = aws_security_group.ssm.id
  description       = "Consultas HTTPS desde la VPC; IAM limita los parametros"
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_endpoint" "ssm" {
  vpc_id              = aws_vpc.platform.id
  service_name        = "com.amazonaws.${var.aws_region}.ssm"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.private.id]
  security_group_ids  = [aws_security_group.ssm.id]
  private_dns_enabled = true

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = "*"
      Action    = ["ssm:GetParametersByPath", "ssm:GetParameters"]
      Resource  = "arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/tenants/*"
    }]
  })

  tags = { Name = "${var.project_name}-ssm", Role = "ssm-endpoint" }
}
