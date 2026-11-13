variable "project_name" {
  description = "Nombre usado para el bucket y las etiquetas del proyecto."
  type        = string
  default     = "attendance-platform"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,28}[a-z0-9]$", var.project_name))
    error_message = "Usa entre 3 y 30 caracteres: letras minúsculas, números y guiones; comienza con letra y termina con letra o número."
  }
}

variable "aws_region" {
  description = "Región del bucket de estado. Debe coincidir con los backend.hcl de sus consumidores."
  type        = string
  default     = "us-east-2"
}
