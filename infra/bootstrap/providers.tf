provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = var.project_name
      Tenant    = "platform"
      Env       = "shared"
      Role      = "state"
      ManagedBy = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
