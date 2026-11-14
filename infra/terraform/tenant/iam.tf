locals {
  app_roles = toset(["frontend", "backend"])
  # Solo comunicaciones del agente: no permite enviar comandos ni leer secretos.
  ssm_agent_actions = [
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
}

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
        Effect   = "Allow"
        Action   = local.ssm_agent_actions
        Resource = "*"
      },
    ]
  })
}

# Actualizacion de la app (P4, E2): Run Command sobre las EC2 existentes.
# Se conserva db_ssm_agent como recurso independiente para no cambiar su direccion en el estado.
resource "aws_iam_role_policy" "app_ssm_agent" {
  for_each = var.base.backups_bucket != "" ? local.app_roles : toset([])
  name     = "ssm-agent-run-command"
  role     = aws_iam_role.instance[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = local.ssm_agent_actions
      Resource = "*"
    }]
  })
}

# Las versiones las publica el worker. Las EC2 solo descargan las de SU tenant/entorno.
resource "aws_iam_role_policy" "app_releases" {
  for_each = var.base.backups_bucket != "" ? local.app_roles : toset([])
  name     = "tenant-releases"
  role     = aws_iam_role.instance[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "arn:${data.aws_partition.current.partition}:s3:::${var.base.backups_bucket}/${local.release_prefix}/*"
      },
      {
        Effect    = "Allow"
        Action    = "s3:ListBucket"
        Resource  = "arn:${data.aws_partition.current.partition}:s3:::${var.base.backups_bucket}"
        Condition = { StringLike = { "s3:prefix" = ["${local.release_prefix}/*"] } }
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
        Resource = "arn:${data.aws_partition.current.partition}:s3:::${var.base.backups_bucket}/${local.backup_prefix}/db/*"
      },
      {
        Effect    = "Allow"
        Action    = "s3:ListBucket"
        Resource  = "arn:${data.aws_partition.current.partition}:s3:::${var.base.backups_bucket}"
        Condition = { StringLike = { "s3:prefix" = ["${local.backup_prefix}/db/*"] } }
      },
    ]
  })
}
