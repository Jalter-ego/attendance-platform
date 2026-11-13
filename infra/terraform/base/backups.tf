# Respaldos de los tenants (P3, B5/B6).
#
#   dump lógico  : la VM db ejecuta pg_dump -> este bucket, prefijo tenants/<id>/<env>/db/
#                  (timer systemd según el plan, o a pedido del worker vía SSM Run Command)
#   snapshot EBS : Data Lifecycle Manager según la etiqueta BackupPolicy del volumen de BD,
#                  o a pedido del worker (scripts infra/backups/tenant-backup.sh)
#
# La retención de los dumps la aplica el lifecycle del bucket según la etiqueta
# retention-days que pone el script al subir cada objeto.

locals {
  backups_bucket = "${var.project_name}-backups-${data.aws_caller_identity.current.account_id}"

  # Catálogo cerrado: plan -> política. Mismas claves que var.backup del módulo tenant.
  # count = cuántos snapshots conserva DLM (= días de retención / frecuencia).
  # cron en UTC: 07:00 UTC = 03:00 America/La_Paz (DLM no admite intervalos > 24 h).
  backup_policies = {
    "weekly-28d" = { cron = "cron(0 7 ? * SUN *)", count = 4 } # Básico
    "daily-14d"  = { cron = "cron(0 7 * * ? *)", count = 14 }  # Estándar
    "daily-30d"  = { cron = "cron(0 7 * * ? *)", count = 30 }  # Avanzado
  }
  # Días admitidos en la etiqueta retention-days de los dumps (7 = copia previa a un restore).
  dump_retention_days = [7, 14, 28, 30]
}

resource "aws_s3_bucket" "backups" {
  bucket = local.backups_bucket

  tags = { Name = local.backups_bucket, Role = "backups" }
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  dynamic "rule" {
    for_each = toset(local.dump_retention_days)
    content {
      id     = "dumps-${rule.value}d"
      status = "Enabled"
      filter {
        tag {
          key   = "retention-days"
          value = tostring(rule.value)
        }
      }
      expiration {
        days = rule.value
      }
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# Solo HTTPS. El acceso por tenant lo limita el rol IAM de cada VM db (prefijo propio).
resource "aws_s3_bucket_policy" "backups" {
  bucket = aws_s3_bucket.backups.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.backups.arn, "${aws_s3_bucket.backups.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.backups]
}

# La subred privada no tiene salida a Internet: S3 por endpoint de gateway (sin costo).
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.platform.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = "*"
      Action    = ["s3:GetObject", "s3:PutObject", "s3:GetObjectTagging", "s3:PutObjectTagging", "s3:ListBucket"]
      Resource  = [aws_s3_bucket.backups.arn, "${aws_s3_bucket.backups.arn}/*"]
    }]
  })

  tags = { Name = "${var.project_name}-s3", Role = "s3-endpoint" }
}

# Run Command necesita, además del endpoint ssm (ssm.tf), ec2messages y ssmmessages.
resource "aws_vpc_endpoint" "ssm_agent" {
  for_each            = toset(["ec2messages", "ssmmessages"])
  vpc_id              = aws_vpc.platform.id
  service_name        = "com.amazonaws.${var.aws_region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.private.id]
  security_group_ids  = [aws_security_group.ssm.id]
  private_dns_enabled = true

  tags = { Name = "${var.project_name}-${each.key}", Role = "ssm-endpoint" }
}

# Snapshots programados: una política DLM por entrada del catálogo. El módulo tenant
# etiqueta el volumen de BD con BackupPolicy=<clave>; DLM solo toca volúmenes de este proyecto.
resource "aws_iam_role" "dlm" {
  name = "${var.project_name}-dlm"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "dlm.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "db" {
  for_each           = local.backup_policies
  description        = "${var.project_name} BD ${each.key}"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]
    target_tags = {
      BackupPolicy = each.key
    }

    schedule {
      name = each.key
      create_rule {
        cron_expression = each.value.cron
      }
      retain_rule {
        count = each.value.count
      }
      copy_tags = true
      tags_to_add = {
        BackupType = "scheduled"
      }
    }
  }

  tags = { Role = "backups" }
}
