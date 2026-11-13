output "state_bucket_name" {
  description = "Bucket que usarán los backends de estado de la plataforma."
  value       = aws_s3_bucket.state.id
}

output "state_bucket_region" {
  description = "Región que se debe configurar en los backends de estado."
  value       = var.aws_region
}

output "bootstrap_backend" {
  description = "Configuración pública para migrar el estado de este bootstrap al bucket creado."
  value = {
    bucket       = aws_s3_bucket.state.id
    key          = "platform/bootstrap/terraform.tfstate"
    region       = var.aws_region
    encrypt      = true
    use_lockfile = true
  }
}
