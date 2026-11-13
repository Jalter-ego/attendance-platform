variable "region" {
  description = "Región de AWS donde se construyen y quedan las AMIs."
  type        = string
  default     = "us-east-2"
}

variable "build_instance_type" {
  description = "Tipo de instancia temporal usada para construir (necesita RAM para compilar la app)."
  type        = string
  default     = "t3.small"
}

variable "image_version" {
  description = "Versión de las imágenes. Una versión nueva = AMIs nuevas = Terraform reemplaza las VMs."
  type        = string
  default     = "0.1.0"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.image_version))
    error_message = "Usa una versión semántica, por ejemplo 0.1.0."
  }
}

variable "git_commit" {
  description = "Commit del repo de la plataforma con el que se construyó (lo pasa el Makefile)."
  type        = string
  default     = "unknown"
}

variable "backend_repo" {
  description = "Repositorio público del backend de la app de asistencia."
  type        = string
  default     = "https://github.com/Jalter-ego/attendance-core.git"
}

variable "backend_ref" {
  description = "Rama, tag o commit del backend que se hornea en la AMI."
  type        = string
  default     = "master"
}

variable "frontend_repo" {
  description = "Repositorio público del frontend de la app de asistencia."
  type        = string
  default     = "https://github.com/Jalter-ego/attendance-web.git"
}

variable "frontend_ref" {
  description = "Rama, tag o commit del frontend que se hornea en la AMI."
  type        = string
  default     = "master"
}

variable "node_version" {
  description = "Versión exacta de Node.js 24."
  type        = string
  default     = "24.15.0"
}

variable "pnpm_version" {
  description = "Versión exacta de pnpm."
  type        = string
  default     = "10.11.0"
}

