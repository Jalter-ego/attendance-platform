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
