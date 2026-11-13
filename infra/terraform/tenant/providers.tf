provider "aws" {
  region = var.base.region

  default_tags {
    tags = {
      Project   = var.base.project_name
      Tenant    = var.tenant_id
      Env       = var.env
      Plan      = var.plan
      ManagedBy = var.engine
    }
  }
}

data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}

data "aws_vpc" "base" {
  id = var.base.vpc_id
}

data "aws_subnet" "public" {
  id = var.base.public_subnet_id
}

data "aws_subnet" "private" {
  id = var.base.private_subnet_id
}

data "aws_security_group" "monitoring" {
  id = var.base.monitoring_security_group_id
}

data "aws_vpc_endpoint" "ssm" {
  id = var.base.ssm_endpoint_id
}

data "aws_ami" "role" {
  for_each = var.ami
  owners   = ["self"]

  filter {
    name   = "image-id"
    values = [each.value]
  }
  filter {
    name   = "tag:Role"
    values = [each.key]
  }
  filter {
    name   = "state"
    values = ["available"]
  }
  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
  filter {
    name   = "root-device-type"
    values = ["ebs"]
  }
}
