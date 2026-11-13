locals {
  roles = toset(["frontend", "backend", "db"])
  # Los nombres IAM tienen limite de 64 caracteres; las etiquetas conservan el ID completo.
  resource_prefix   = "${substr(var.base.project_name, 0, 12)}-${substr(var.tenant_id, 0, 16)}-${var.env}-${substr(sha256("${var.base.project_name}/${var.tenant_id}/${var.env}"), 0, 8)}"
  ssm_prefix        = "/tenants/${var.tenant_id}/${var.env}"
  ssm_arn           = "arn:${data.aws_partition.current.partition}:ssm:${var.base.region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}"
  template_path     = var.cloud_init_template_path != null ? var.cloud_init_template_path : "${path.module}/../../cloud-init/user-data.yaml.tftpl"
  template_exists   = fileexists(local.template_path)
  backup_policy     = "${var.backup.schedule}-${var.backup.retention_days}d"
  backup_policy_tag = "${var.base.project_name}:${local.backup_policy}"
  backup_prefix     = "tenants/${var.tenant_id}/${var.env}"

  boot_common = {
    tenant_id        = var.tenant_id
    env              = var.env
    plan             = var.plan
    region           = var.base.region
    ssm_prefix       = local.ssm_prefix
    vpc_cidr         = data.aws_vpc.base.cidr_block
    db_host          = ""
    backend_host     = ""
    db_volume_id     = ""
    institution_name = var.name
    timezone         = var.timezone
    admin_email      = var.contact_email
    limits           = var.limits
    # Respaldos (P3): la VM db sube sus dumps a tenants/<id>/<env>/db/ en este bucket.
    backup_bucket         = var.base.backups_bucket
    backup_schedule       = var.backup.schedule
    backup_retention_days = var.backup.retention_days
  }
}

resource "terraform_data" "prerequisites" {
  lifecycle {
    precondition {
      condition     = local.template_exists
      error_message = "No se encuentra la plantilla cloud-init en ${local.template_path}. Integra la plantilla validada de P3 o indica su ruta absoluta en cloud_init_template_path si el modulo se ejecuta desde otra ubicacion."
    }
    precondition {
      condition = (
        data.aws_subnet.public.vpc_id == var.base.vpc_id &&
        data.aws_subnet.private.vpc_id == var.base.vpc_id &&
        data.aws_security_group.monitoring.vpc_id == var.base.vpc_id &&
        data.aws_subnet.public.id != data.aws_subnet.private.id &&
        data.aws_subnet.private.availability_zone == var.base.availability_zone
      )
      error_message = "Las subredes y el SG deben pertenecer a la VPC compartida; la BD y su EBS deben usar la misma AZ."
    }
    precondition {
      condition = (
        data.aws_vpc_endpoint.ssm.vpc_id == var.base.vpc_id &&
        data.aws_vpc_endpoint.ssm.service_name == "com.amazonaws.${var.base.region}.ssm" &&
        data.aws_vpc_endpoint.ssm.state == "available" &&
        data.aws_vpc_endpoint.ssm.private_dns_enabled
      )
      error_message = "Actualiza la base: se requiere el endpoint SSM disponible, en la misma VPC y con DNS privado."
    }
  }
}
