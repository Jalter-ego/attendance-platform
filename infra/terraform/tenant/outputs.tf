output "deployment_name" {
  value = local.resource_prefix
}

output "urls" {
  description = "URLs con la IP publica actual tras el cambio de estado; campos null al suspender. Verificar health antes de marcar listo."
  value = {
    frontend        = var.suspended ? null : "http://${data.aws_instance.frontend_runtime.public_ip}/"
    api             = var.suspended ? null : "http://${data.aws_instance.frontend_runtime.public_ip}/core/api/v1"
    frontend_health = var.suspended ? null : "http://${data.aws_instance.frontend_runtime.public_ip}/healthz"
    backend_health  = var.suspended ? null : "http://${data.aws_instance.frontend_runtime.public_ip}/core/api/v1/health"
  }
}

output "suspended" {
  description = "Estado de suspension solicitado; running no garantiza que la aplicacion ya haya terminado de arrancar."
  value       = var.suspended
}

output "instance_ids" {
  value = { frontend = aws_instance.frontend.id, backend = aws_instance.backend.id, db = aws_instance.db.id }
}

output "private_ips" {
  value = { frontend = aws_instance.frontend.private_ip, backend = aws_instance.backend.private_ip, db = aws_instance.db.private_ip }
}

output "db_volume_id" {
  description = "EBS separado del root: sobrevive a reemplazar la EC2, pero destroy del tenant SI lo elimina."
  value       = aws_ebs_volume.db.id
}

output "ssm_prefix" {
  value = local.ssm_prefix
}

output "instance_role_arns" {
  value = { for role, resource in aws_iam_role.instance : role => resource.arn }
}

output "ami_ids" {
  value = { for role, image in data.aws_ami.role : role => image.id }
}

output "backup" {
  description = "Donde quedan los respaldos de este tenant (dumps en S3 y politica DLM de snapshots)."
  value = {
    bucket = var.base.backups_bucket
    prefix = local.backup_prefix
    policy = var.base.backups_bucket != "" ? local.backup_policy : null
  }
}
