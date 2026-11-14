variable "project_name" {
  description = "Nombre del proyecto; debe coincidir con el bootstrap y los otros motores."
  type        = string
  default     = "attendance-platform"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,28}[a-z0-9]$", var.project_name))
    error_message = "Usa entre 3 y 30 caracteres: letras minúsculas, números y guiones; comienza con letra y termina con letra o número."
  }
}

variable "aws_region" {
  description = "Región de la infraestructura de la plataforma."
  type        = string
  default     = "us-east-2"
}

variable "vpc_cidr" {
  description = "Red IPv4 /16; de ella se derivan una subred pública y una privada /24."
  type        = string
  default     = "10.90.0.0/16"

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr)) && endswith(var.vpc_cidr, "/16")
    error_message = "Indica una red IPv4 válida con prefijo /16."
  }
}

variable "operator_cidrs" {
  description = "IPs/redes IPv4 autorizadas para SSH de Packer y para SSH/Grafana de monitoreo. Vacío deja esos accesos cerrados."
  type        = set(string)
  default     = []

  validation {
    condition = alltrue([
      for cidr in var.operator_cidrs :
      can(cidrnetmask(cidr)) && try(tonumber(split("/", cidr)[1]) >= 24, false)
    ])
    error_message = "Usa CIDR IPv4 /24 o más específicos, normalmente una IP pública seguida de /32."
  }
}

variable "monitoring" {
  description = "EC2 compartida de Prometheus/Grafana desde la AMI de P3. null mantiene solo la red; no crea servidores."
  type = object({
    ami_id              = string
    instance_type       = optional(string, "t3.small")
    root_volume_size_gb = optional(number, 20)
  })
  default = null

  validation {
    condition = var.monitoring == null ? true : (
      can(regex("^ami-[a-f0-9]{17}$", var.monitoring.ami_id)) &&
      var.monitoring.ami_id != "ami-00000000000000000"
    )
    error_message = "Usa el ID concreto de la AMI monitoring de P3, de esta cuenta y region."
  }

  validation {
    condition     = var.monitoring == null ? true : contains(["t3.micro", "t3.small", "t3.medium", "t3.large"], var.monitoring.instance_type)
    error_message = "La AMI de monitoreo es x86_64: usa t3.micro, t3.small, t3.medium o t3.large."
  }

  validation {
    condition = var.monitoring == null ? true : (
      var.monitoring.root_volume_size_gb >= 12 &&
      floor(var.monitoring.root_volume_size_gb) == var.monitoring.root_volume_size_gb
    )
    error_message = "El disco de monitoreo debe tener al menos 12 GiB, en un numero entero."
  }
}
