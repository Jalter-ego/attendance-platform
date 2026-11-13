mock_provider "aws" {
  override_during = plan

  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_vpc" {
    defaults = { cidr_block = "10.90.0.0/16" }
  }
  mock_data "aws_security_group" {
    defaults = { vpc_id = "vpc-00000000000000001" }
  }
  mock_data "aws_vpc_endpoint" {
    defaults = {
      vpc_id              = "vpc-00000000000000001"
      service_name        = "com.amazonaws.us-east-2.ssm"
      state               = "available"
      private_dns_enabled = true
    }
  }
}

override_data {
  override_during = plan
  target          = data.aws_subnet.public
  values = {
    id                = "subnet-00000000000000001"
    vpc_id            = "vpc-00000000000000001"
    availability_zone = "us-east-2a"
  }
}

override_data {
  override_during = plan
  target          = data.aws_subnet.private
  values = {
    id                = "subnet-00000000000000002"
    vpc_id            = "vpc-00000000000000001"
    availability_zone = "us-east-2a"
  }
}

override_data {
  override_during = plan
  target          = data.aws_ami.role["frontend"]
  values          = { id = "ami-11111111111111111" }
}

override_data {
  override_during = plan
  target          = data.aws_ami.role["backend"]
  values          = { id = "ami-22222222222222222" }
}

override_data {
  override_during = plan
  target          = data.aws_ami.role["db"]
  values          = { id = "ami-33333333333333333" }
}

override_resource {
  target          = aws_security_group.role["frontend"]
  override_during = plan
  values          = { id = "sg-00000000000000001" }
}

override_resource {
  target          = aws_security_group.role["backend"]
  override_during = plan
  values          = { id = "sg-00000000000000002" }
}

override_resource {
  target          = aws_security_group.role["db"]
  override_during = plan
  values          = { id = "sg-00000000000000003" }
}

override_resource {
  target          = aws_ebs_volume.db
  override_during = plan
  values          = { id = "vol-00000000000000001" }
}

override_resource {
  target          = aws_instance.db
  override_during = plan
  values          = { id = "i-00000000000000001", private_ip = "10.90.2.10" }
}

override_resource {
  target          = aws_instance.backend
  override_during = plan
  values          = { id = "i-00000000000000002", private_ip = "10.90.2.11" }
}

override_resource {
  target          = aws_instance.frontend
  override_during = plan
  values          = { id = "i-00000000000000003", private_ip = "10.90.1.10", public_ip = "198.51.100.20" }
}

variables {
  base = {
    project_name                 = "attendance-platform"
    region                       = "us-east-2"
    availability_zone            = "us-east-2a"
    vpc_id                       = "vpc-00000000000000001"
    public_subnet_id             = "subnet-00000000000000001"
    private_subnet_id            = "subnet-00000000000000002"
    monitoring_security_group_id = "sg-00000000000000004"
    ssm_endpoint_id              = "vpce-00000000000000001"
  }
  tenant_id                = "san-marcos"
  env                      = "test"
  name                     = "Instituto San Marcos"
  contact_email            = "admin@example.com"
  plan                     = "basic"
  sizing                   = { frontend = "t3.micro", backend = "t3.small", db = "t3.micro", db_disk_gb = 10 }
  ami                      = { frontend = "ami-11111111111111111", backend = "ami-22222222222222222", db = "ami-33333333333333333" }
  cloud_init_template_path = "./tests/fixtures/metadata.yaml.tftpl"
}

run "tenant_isolation_and_storage" {
  command = plan

  assert {
    condition = (
      aws_instance.frontend.associate_public_ip_address &&
      !aws_instance.backend.associate_public_ip_address &&
      !aws_instance.db.associate_public_ip_address &&
      aws_instance.frontend.subnet_id == var.base.public_subnet_id &&
      aws_instance.backend.subnet_id == var.base.private_subnet_id &&
      aws_instance.db.subnet_id == var.base.private_subnet_id
    )
    error_message = "Solo nginx debe tener IP publica; backend y PostgreSQL deben quedar privados."
  }

  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.backend_api.referenced_security_group_id == aws_security_group.role["frontend"].id &&
      aws_vpc_security_group_ingress_rule.database.referenced_security_group_id == aws_security_group.role["backend"].id &&
      aws_vpc_security_group_ingress_rule.database.from_port == 5432 &&
      length(aws_vpc_security_group_ingress_rule.exporter) == 12 &&
      alltrue([for rule in aws_vpc_security_group_ingress_rule.exporter : rule.referenced_security_group_id == var.base.monitoring_security_group_id])
    )
    error_message = "La API y la BD deben admitir solo sus SG del tenant; los exporters solo monitoreo."
  }

  assert {
    condition = (
      aws_ebs_volume.db.encrypted && aws_ebs_volume.db.size == 10 &&
      aws_volume_attachment.db.volume_id == aws_ebs_volume.db.id &&
      aws_volume_attachment.db.instance_id == aws_instance.db.id &&
      aws_volume_attachment.db.stop_instance_before_detaching && !aws_volume_attachment.db.force_detach
    )
    error_message = "La BD debe usar un EBS cifrado separado y detenerse antes de desacoplarlo."
  }

  assert {
    condition = alltrue([
      for instance in [aws_instance.frontend, aws_instance.backend, aws_instance.db] :
      instance.metadata_options[0].http_tokens == "required" &&
      instance.root_block_device[0].encrypted && instance.user_data_replace_on_change
    ])
    error_message = "Las tres instancias deben requerir IMDSv2, cifrar root y reemplazarse al cambiar cloud-init."
  }

  assert {
    condition = (
      strcontains(aws_instance.db.user_data, "vol-00000000000000001") &&
      strcontains(aws_instance.backend.user_data, "10.90.2.10") &&
      strcontains(aws_instance.frontend.user_data, "10.90.2.11") &&
      strcontains(aws_instance.backend.user_data, "/tenants/san-marcos/test")
    )
    error_message = "Cloud-init debe recibir el EBS en DB, la IP de DB en backend y la IP de backend en frontend."
  }

  assert {
    condition = (
      length(aws_iam_role_policy.parameters) == 2 &&
      alltrue([for policy in aws_iam_role_policy.parameters :
        toset(jsondecode(policy.policy).Statement[0].Resource) == toset([
          "arn:aws:ssm:us-east-2:123456789012:parameter/tenants/san-marcos/test",
          "arn:aws:ssm:us-east-2:123456789012:parameter/tenants/san-marcos/test/*"
        ])
      ]) &&
      output.urls.api == "http://198.51.100.20/core/api/v1"
    )
    error_message = "SSM debe limitarse a este tenant/entorno; la URL de API debe usar el proxy publico."
  }
}

run "another_tenant_has_its_own_prefix" {
  command = plan

  variables {
    tenant_id = "otro-cliente"
    env       = "prod"
  }

  assert {
    condition = (
      output.ssm_prefix == "/tenants/otro-cliente/prod" &&
      !strcontains(aws_iam_role_policy.parameters["backend"].policy, "san-marcos") &&
      aws_iam_role.instance["db"].name != "${run.tenant_isolation_and_storage.deployment_name}-db"
    )
    error_message = "Cambiar tenant/entorno debe cambiar los permisos y los nombres de los recursos."
  }
}

run "reject_missing_cloud_init" {
  command = plan

  variables {
    cloud_init_template_path = "./tests/fixtures/missing.yaml.tftpl"
  }

  expect_failures = [terraform_data.prerequisites]
}

run "reject_arm_instance_type" {
  command = plan

  variables {
    sizing = { frontend = "t4g.micro", backend = "t3.small", db = "t3.micro", db_disk_gb = 10 }
  }

  expect_failures = [var.sizing]
}

run "reject_subnet_from_another_vpc" {
  command = plan

  override_data {
    override_during = plan
    target          = data.aws_subnet.private
    values = {
      id                = "subnet-00000000000000002"
      vpc_id            = "vpc-00000000000000009"
      availability_zone = "us-east-2a"
    }
  }

  expect_failures = [terraform_data.prerequisites]
}

run "reject_endpoint_without_private_dns" {
  command = plan

  override_data {
    override_during = plan
    target          = data.aws_vpc_endpoint.ssm
    values = {
      vpc_id              = "vpc-00000000000000001"
      service_name        = "com.amazonaws.us-east-2.ssm"
      state               = "available"
      private_dns_enabled = false
    }
  }

  expect_failures = [terraform_data.prerequisites]
}

run "backups_preserve_tenant_and_project_isolation" {
  command = plan

  variables {
    base = {
      project_name                 = "attendance-platform"
      region                       = "us-east-2"
      availability_zone            = "us-east-2a"
      vpc_id                       = "vpc-00000000000000001"
      public_subnet_id             = "subnet-00000000000000001"
      private_subnet_id            = "subnet-00000000000000002"
      monitoring_security_group_id = "sg-00000000000000004"
      ssm_endpoint_id              = "vpce-00000000000000001"
      backups_bucket               = "attendance-platform-backups-123456789012"
    }
    backup = { schedule = "daily", retention_days = 14 }
  }

  assert {
    condition = (
      aws_ebs_volume.db.tags["BackupPolicy"] == "attendance-platform:daily-14d" &&
      output.backup.policy == "daily-14d" &&
      output.backup.prefix == "tenants/san-marcos/test" &&
      strcontains(aws_instance.db.user_data, "attendance-platform-backups-123456789012")
    )
    error_message = "La BD debe recibir la configuracion de respaldos y una etiqueta DLM limitada al proyecto."
  }

  assert {
    condition = (
      length(aws_iam_role_policy.db_backups) == 1 &&
      jsondecode(aws_iam_role_policy.db_backups[0].policy).Statement[0].Resource == "arn:aws:s3:::attendance-platform-backups-123456789012/tenants/san-marcos/test/*" &&
      jsondecode(aws_iam_role_policy.db_backups[0].policy).Statement[1].Condition.StringLike["s3:prefix"] == ["tenants/san-marcos/test/*"]
    )
    error_message = "La VM de BD solo debe leer, escribir y listar respaldos de su tenant/entorno."
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_role_policy.db_ssm_agent[0].policy).Statement :
      alltrue([for action in statement.Action : !contains(["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath", "ssm:*", "*"], action)])
    ])
    error_message = "Los permisos del agente SSM deben conservar la separacion de secretos entre tenants."
  }
}
