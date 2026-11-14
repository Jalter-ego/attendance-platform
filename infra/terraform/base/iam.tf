# Identidad del servicio que correra en EC2; no modifica las cuentas del equipo.
resource "aws_iam_role" "monitoring" {
  name = "${var.project_name}-monitoring"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = { Role = "monitoring" }
}

resource "aws_iam_role_policy" "monitoring_discovery" {
  name = "discover-tenant-instances"
  role = aws_iam_role.monitoring.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ec2:DescribeInstances",
        "ec2:DescribeAvailabilityZones",
      ]
      Resource = "*"
    }]
  })
}

resource "aws_iam_instance_profile" "monitoring" {
  name = "${var.project_name}-monitoring"
  role = aws_iam_role.monitoring.name

  tags = { Role = "monitoring" }
}

# P5 puede configurar la VM con Run Command, sin claves SSH. Solo acciones del agente:
# no se adjunta AmazonSSMManagedInstanceCore porque incluye lectura global de parametros.
resource "aws_iam_role_policy" "monitoring_ssm_agent" {
  count = var.monitoring == null ? 0 : 1
  name  = "ssm-agent-run-command"
  role  = aws_iam_role.monitoring.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ssm:UpdateInstanceInformation",
        "ssm:ListInstanceAssociations",
        "ssm:DescribeAssociation",
        "ssm:UpdateInstanceAssociationStatus",
        "ssm:GetDocument",
        "ssm:DescribeDocument",
        "ec2messages:AcknowledgeMessage",
        "ec2messages:DeleteMessage",
        "ec2messages:FailMessage",
        "ec2messages:GetEndpoint",
        "ec2messages:GetMessages",
        "ec2messages:SendReply",
        "ssmmessages:CreateControlChannel",
        "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:OpenDataChannel",
      ]
      Resource = "*"
    }]
  })
}
