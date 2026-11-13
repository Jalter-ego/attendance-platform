variable "base" {
  description = "Output integration de la base compartida; no contiene credenciales."
  type = object({
    project_name                 = string
    region                       = string
    availability_zone            = string
    vpc_id                       = string
    public_subnet_id             = string
    private_subnet_id            = string
    monitoring_security_group_id = string
    ssm_endpoint_id              = string
  })
}

variable "tenant_id" {
  description = "Identidad estable de la instalacion en la plataforma."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$", var.tenant_id))
    error_message = "tenant_id debe tener 3-40 caracteres: minusculas, numeros y guiones, sin guion inicial/final."
  }
}

variable "env" {
  type        = string
  description = "Entorno que forma parte del prefijo SSM y de la clave del estado."

  validation {
    condition     = contains(["test", "prod"], var.env)
    error_message = "El entorno debe ser test o prod."
  }
}

variable "name" {
  type        = string
  description = "Nombre de la institucion que mostrara Attendance."

  validation {
    condition     = length(trimspace(var.name)) > 0
    error_message = "Indica el nombre de la institucion."
  }
}

variable "contact_email" {
  type        = string
  description = "Correo del administrador inicial; su password se obtiene desde SSM."
}

variable "timezone" {
  type        = string
  default     = "America/La_Paz"
  description = "Zona IANA de la institucion y cloud-init."

  validation {
    condition     = can(regex("^[A-Za-z0-9_+/-]+$", var.timezone))
    error_message = "Indica una zona IANA sin espacios, por ejemplo America/La_Paz o UTC."
  }
}

variable "plan" {
  type        = string
  description = "Codigo del catalogo de P4; los tamanos se reciben por separado."
}

variable "engine" {
  type        = string
  default     = "terraform"
  description = "Motor que administra este estado; no cambiarlo sin migracion."

  validation {
    condition     = contains(["terraform", "tofu"], var.engine)
    error_message = "Este modulo se ejecuta con terraform o tofu."
  }
}

variable "sizing" {
  type = object({
    frontend   = string
    backend    = string
    db         = string
    db_disk_gb = number
  })
  description = "Tamanos del plan. Las AMIs actuales son x86_64 y el montaje de BD utiliza Nitro."

  validation {
    condition     = var.sizing.db_disk_gb >= 10 && floor(var.sizing.db_disk_gb) == var.sizing.db_disk_gb
    error_message = "El disco de PostgreSQL debe tener al menos 10 GiB, en un numero entero."
  }

  validation {
    condition = alltrue([
      for size in [var.sizing.frontend, var.sizing.backend, var.sizing.db] :
      contains(["t3.micro", "t3.small", "t3.medium", "t3.large"], size)
    ])
    error_message = "Los tamanos iniciales admitidos son t3.micro, t3.small, t3.medium y t3.large (x86_64/Nitro)."
  }
}

variable "ami" {
  type = object({
    frontend = string
    backend  = string
    db       = string
  })
  description = "IDs concretos de las tres AMIs de P3, de esta cuenta y region. No se elige latest."

  validation {
    condition = alltrue([
      for id in values(var.ami) :
      can(regex("^ami-[a-f0-9]{17}$", id)) && id != "ami-00000000000000000"
    ])
    error_message = "Reemplaza los ejemplos por IDs reales de las AMIs de Packer."
  }
}

variable "limits" {
  type        = map(number)
  default     = {}
  description = "Datos opcionales del plan para cloud-init; su aplicacion corresponde a P4."
}

variable "cloud_init_template_path" {
  type        = string
  default     = null
  description = "Ruta alternativa de la plantilla de P3; null usa infra/cloud-init/user-data.yaml.tftpl."
}
