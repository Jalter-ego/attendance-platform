resource "aws_iam_role" "instance" {
  for_each = local.roles
  name     = "${local.resource_prefix}-${each.key}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })

  tags = { Role = each.key }
}

# El frontend no lee secretos. P3 lee el prefijo completo en backend y DB.
resource "aws_iam_role_policy" "parameters" {
  for_each = toset(["backend", "db"])
  name     = "tenant-parameters"
  role     = aws_iam_role.instance[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssm:GetParametersByPath", "ssm:GetParameters"]
      Resource = [local.ssm_arn, "${local.ssm_arn}/*"]
    }]
  })
}

resource "aws_iam_instance_profile" "instance" {
  for_each = local.roles
  name     = aws_iam_role.instance[each.key].name
  role     = aws_iam_role.instance[each.key].name

  tags = { Role = each.key }
}

# Respaldos (P3): la VM db recibe Run Command del worker y sube/baja dumps de SU prefijo.
# No se usa AmazonSSMManagedInstanceCore: incluye ssm:GetParameters sobre "*" y permitiría
# leer secretos de otros tenants. Aquí solo van las acciones del agente para Run Command.
resource "aws_iam_role_policy" "db_ssm_agent" {
  count = var.base.backups_bucket != "" ? 1 : 0
  name  = "ssm-agent-run-command"
  role  = aws_iam_role.instance["db"].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
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
      },
    ]
  })
}

resource "aws_iam_role_policy" "db_backups" {
  count = var.base.backups_bucket != "" ? 1 : 0
  name  = "tenant-backups"
  role  = aws_iam_role.instance["db"].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject", "s3:PutObjectTagging", "s3:GetObjectTagging"]
        Resource = "arn:${data.aws_partition.current.partition}:s3:::${var.base.backups_bucket}/${local.backup_prefix}/*"
      },
      {
        Effect    = "Allow"
        Action    = "s3:ListBucket"
        Resource  = "arn:${data.aws_partition.current.partition}:s3:::${var.base.backups_bucket}"
        Condition = { StringLike = { "s3:prefix" = ["${local.backup_prefix}/*"] } }
      },
    ]
  })
}
