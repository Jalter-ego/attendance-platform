mock_provider "aws" {
  override_during = plan

  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }

  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }

  mock_data "aws_availability_zones" {
    defaults = {
      names = ["us-east-2a"]
    }
  }

  mock_data "aws_ami" {
    defaults = { id = "ami-11111111111111111" }
  }

  mock_resource "aws_instance" {
    defaults = {
      id         = "i-00000000000000001"
      public_ip  = "198.51.100.25"
      private_ip = "10.90.1.25"
    }
  }
}

override_resource {
  target          = aws_vpc.platform
  override_during = plan
  values          = { id = "vpc-00000000000000001" }
}

override_resource {
  target          = aws_subnet.public
  override_during = plan
  values          = { id = "subnet-00000000000000001" }
}

override_resource {
  target          = aws_subnet.private
  override_during = plan
  values          = { id = "subnet-00000000000000002" }
}

override_resource {
  target          = aws_route_table.public
  override_during = plan
  values          = { id = "rtb-00000000000000001" }
}

override_resource {
  target          = aws_route_table.private
  override_during = plan
  values          = { id = "rtb-00000000000000002" }
}

override_resource {
  target          = aws_s3_bucket.backups
  override_during = plan
  values          = { arn = "arn:aws:s3:::attendance-platform-backups-123456789012" }
}

override_resource {
  target          = aws_security_group.monitoring
  override_during = plan
  values          = { id = "sg-00000000000000004" }
}

override_resource {
  target          = aws_iam_role.monitoring
  override_during = plan
  values          = { id = "attendance-platform-monitoring" }
}

run "isolated_network" {
  command = plan

  assert {
    condition     = aws_vpc.platform.enable_dns_support && aws_vpc.platform.enable_dns_hostnames
    error_message = "El DNS de la VPC es necesario para los servicios AWS y las futuras conexiones privadas."
  }

  assert {
    condition = (
      aws_subnet.public.cidr_block != aws_subnet.private.cidr_block &&
      aws_subnet.public.availability_zone == aws_subnet.private.availability_zone &&
      !aws_subnet.public.map_public_ip_on_launch &&
      !aws_subnet.private.map_public_ip_on_launch
    )
    error_message = "Las subredes deben ser distintas y la asignacion de IP publica debe decidirla cada despliegue."
  }

  assert {
    condition = (
      aws_route.internet.destination_cidr_block == "0.0.0.0/0" &&
      aws_route_table_association.public.subnet_id == aws_subnet.public.id &&
      aws_route_table_association.private.subnet_id == aws_subnet.private.id &&
      aws_route_table_association.private.route_table_id != aws_route_table_association.public.route_table_id
    )
    error_message = "La subred privada no debe compartir la tabla de rutas publica."
  }

  assert {
    condition = (
      length(aws_vpc_security_group_ingress_rule.packer_ssh) == 0 &&
      length(aws_vpc_security_group_ingress_rule.monitoring_ssh) == 0 &&
      length(aws_vpc_security_group_ingress_rule.grafana) == 0
    )
    error_message = "Sin IPs autorizadas no debe haber reglas entrantes SSH/Grafana."
  }

  assert {
    condition = toset(jsondecode(aws_iam_role_policy.monitoring_discovery.policy).Statement[0].Action) == toset([
      "ec2:DescribeInstances", "ec2:DescribeAvailabilityZones",
    ])
    error_message = "Prometheus solo necesita lectura de descubrimiento de instancias, no permisos de administrador."
  }

  assert {
    condition = (
      output.integration.vpc_id == "vpc-00000000000000001" &&
      output.integration.public_subnet_id == "subnet-00000000000000001" &&
      output.integration.private_subnet_id == "subnet-00000000000000002"
    )
    error_message = "Los consumidores deben poder distinguir los IDs de la red publica y privada."
  }

  assert {
    condition = (
      length(aws_instance.monitoring) == 0 &&
      length(aws_iam_role_policy.monitoring_ssm_agent) == 0 &&
      output.integration.monitoring_instance_id == null &&
      output.integration.monitoring_private_ip == null &&
      output.integration.monitoring_public_ip == null &&
      output.integration.grafana_url == null
    )
    error_message = "Sin configuracion de monitoreo no se deben crear EC2 ni entregar URLs inexistentes."
  }
}

run "restricted_operator_access" {
  command = plan

  variables {
    operator_cidrs = ["198.51.100.10/32"]
  }

  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.packer_ssh["198.51.100.10/32"].from_port == 22 &&
      aws_vpc_security_group_ingress_rule.packer_ssh["198.51.100.10/32"].cidr_ipv4 == "198.51.100.10/32" &&
      aws_vpc_security_group_ingress_rule.grafana["198.51.100.10/32"].from_port == 3000 &&
      aws_vpc_security_group_ingress_rule.grafana["198.51.100.10/32"].cidr_ipv4 == "198.51.100.10/32"
    )
    error_message = "SSH y Grafana solo deben abrirse para la conexion indicada."
  }
}

run "private_parameter_store" {
  command = plan

  assert {
    condition = (
      aws_vpc_endpoint.ssm.vpc_id == aws_vpc.platform.id &&
      aws_vpc_endpoint.ssm.service_name == "com.amazonaws.us-east-2.ssm" &&
      aws_vpc_endpoint.ssm.private_dns_enabled &&
      toset(aws_vpc_endpoint.ssm.subnet_ids) == toset([aws_subnet.private.id]) &&
      aws_vpc_security_group_ingress_rule.ssm.cidr_ipv4 == var.vpc_cidr &&
      aws_vpc_security_group_ingress_rule.ssm.from_port == 443
    )
    error_message = "Parameter Store debe alcanzarse por HTTPS privado desde la VPC."
  }

  assert {
    condition = (
      jsondecode(aws_vpc_endpoint.ssm.policy).Statement[0].Resource == "arn:aws:ssm:us-east-2:123456789012:parameter/tenants/*" &&
      toset(jsondecode(aws_vpc_endpoint.ssm.policy).Statement[0].Action) == toset(["ssm:GetParametersByPath", "ssm:GetParameters"])
    )
    error_message = "El endpoint debe permitir lectura de parametros de tenants, sin acceso administrativo."
  }
}

run "reject_public_admin_access" {
  command = plan

  variables {
    operator_cidrs = ["0.0.0.0/0"]
  }

  expect_failures = [var.operator_cidrs]
}

run "backup_resources_and_project_isolation" {
  command = plan

  assert {
    condition = (
      length(aws_dlm_lifecycle_policy.db) == 3 &&
      alltrue([for policy, resource in aws_dlm_lifecycle_policy.db :
        resource.policy_details[0].target_tags == tomap({ BackupPolicy = "attendance-platform:${policy}" })
      ])
    )
    error_message = "DLM debe usar una sola etiqueta que combine proyecto y politica; varias etiquetas se combinan con OR."
  }

  assert {
    condition = (
      aws_s3_bucket.backups.bucket == "attendance-platform-backups-123456789012" &&
      aws_s3_bucket_public_access_block.backups.block_public_acls &&
      aws_s3_bucket_public_access_block.backups.block_public_policy &&
      aws_s3_bucket_public_access_block.backups.ignore_public_acls &&
      aws_s3_bucket_public_access_block.backups.restrict_public_buckets &&
      one(aws_s3_bucket_server_side_encryption_configuration.backups.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "AES256"
    )
    error_message = "Los respaldos deben usar un bucket propio cifrado y con los cuatro bloqueos de acceso publico."
  }

  assert {
    condition = (
      aws_vpc_endpoint.s3.vpc_endpoint_type == "Gateway" &&
      toset(aws_vpc_endpoint.s3.route_table_ids) == toset([aws_route_table.private.id]) &&
      toset(keys(aws_vpc_endpoint.ssm_agent)) == toset(["ec2messages", "ssmmessages"]) &&
      alltrue([for endpoint in aws_vpc_endpoint.ssm_agent : endpoint.private_dns_enabled])
    )
    error_message = "El acceso S3 y los canales SSM deben estar disponibles desde la subred privada."
  }

  assert {
    condition = (
      contains(jsondecode(aws_vpc_endpoint.s3.policy).Statement[0].Action, "s3:GetObject") &&
      toset(jsondecode(aws_vpc_endpoint.s3.policy).Statement[0].Resource) == toset([
        "arn:aws:s3:::attendance-platform-backups-123456789012",
        "arn:aws:s3:::attendance-platform-backups-123456789012/*",
      ])
    )
    error_message = "El endpoint privado debe admitir descargar releases y dumps del bucket compartido; IAM limita cada tenant."
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(aws_vpc_endpoint.ssm.policy).Statement :
      statement.Resource != "*" || alltrue([
        for action in statement.Action : !contains(["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath", "ssm:*", "*"], action)
      ])
    ])
    error_message = "Ampliar SSM para Run Command no debe habilitar lectura global de secretos."
  }
}

run "reject_invalid_vpc" {
  command = plan

  variables {
    vpc_cidr = "10.90.0.0/24"
  }

  expect_failures = [var.vpc_cidr]
}

run "monitoring_uses_shared_network_and_secure_boot" {
  command = plan

  variables {
    monitoring = { ami_id = "ami-11111111111111111" }
  }

  assert {
    condition = (
      length(aws_instance.monitoring) == 1 &&
      aws_instance.monitoring[0].ami == var.monitoring.ami_id &&
      data.aws_ami.monitoring[0].owners == tolist(["self"]) &&
      contains([for filter in data.aws_ami.monitoring[0].filter : filter.name == "tag:Role" && filter.values == toset(["monitoring"])], true) &&
      aws_instance.monitoring[0].subnet_id == aws_subnet.public.id &&
      aws_instance.monitoring[0].associate_public_ip_address &&
      aws_instance.monitoring[0].vpc_security_group_ids == toset([aws_security_group.monitoring.id]) &&
      aws_instance.monitoring[0].iam_instance_profile == aws_iam_instance_profile.monitoring.name &&
      aws_instance.monitoring[0].tags["Role"] == "monitoring"
    )
    error_message = "Debe crearse una sola EC2 desde la AMI monitoring de P3, con el SG/perfil compartidos y salida publica."
  }

  assert {
    condition = (
      aws_instance.monitoring[0].instance_type == "t3.small" &&
      aws_instance.monitoring[0].root_block_device[0].volume_type == "gp3" &&
      aws_instance.monitoring[0].root_block_device[0].volume_size == 20 &&
      aws_instance.monitoring[0].root_block_device[0].encrypted &&
      aws_instance.monitoring[0].root_block_device[0].delete_on_termination &&
      aws_instance.monitoring[0].metadata_options[0].http_tokens == "required" &&
      aws_instance.monitoring[0].credit_specification[0].cpu_credits == "standard" &&
      aws_instance.monitoring[0].user_data_replace_on_change &&
      strcontains(aws_instance.monitoring[0].user_data, "grafana-server") &&
      strcontains(aws_instance.monitoring[0].user_data, "snap.amazon-ssm-agent.amazon-ssm-agent.service")
    )
    error_message = "Monitoreo debe usar los tamanos previstos, disco cifrado, IMDSv2 y arrancar servicios ya instalados."
  }

  assert {
    condition = (
      output.integration.monitoring_instance_id == "i-00000000000000001" &&
      output.integration.monitoring_private_ip == "10.90.1.25" &&
      output.integration.monitoring_public_ip == "198.51.100.25" &&
      output.integration.grafana_url == "http://198.51.100.25:3000" &&
      length(aws_vpc_security_group_ingress_rule.grafana) == 0
    )
    error_message = "Los outputs deben entregar IDs y URL sin abrir Grafana mientras falten IPs autorizadas."
  }

  assert {
    condition = (
      length(aws_iam_role_policy.monitoring_ssm_agent) == 1 &&
      aws_iam_role_policy.monitoring_ssm_agent[0].role == aws_iam_role.monitoring.id &&
      contains(jsondecode(aws_iam_role_policy.monitoring_ssm_agent[0].policy).Statement[0].Action, "ssmmessages:OpenControlChannel") &&
      alltrue([for statement in jsondecode(aws_iam_role_policy.monitoring_ssm_agent[0].policy).Statement :
        alltrue([for action in statement.Action :
          !contains(["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath", "ssm:SendCommand", "ssm:*", "*"], action)
        ])
      ])
    )
    error_message = "El agente debe recibir comandos sin permiso para enviar comandos ni leer secretos de tenants."
  }
}

run "monitoring_stopped_has_no_public_url" {
  command = plan

  variables {
    monitoring = { ami_id = "ami-11111111111111111" }
  }

  override_resource {
    target          = aws_instance.monitoring[0]
    override_during = plan
    values          = { public_ip = "" }
  }

  assert {
    condition = (
      output.integration.monitoring_public_ip == null &&
      output.integration.grafana_url == null
    )
    error_message = "Una EC2 sin IP publica no debe producir una URL de Grafana invalida."
  }
}

run "reject_monitoring_arm_size" {
  command = plan

  variables {
    monitoring = { ami_id = "ami-11111111111111111", instance_type = "t4g.small" }
  }

  expect_failures = [var.monitoring]
}

run "reject_monitoring_placeholder_ami" {
  command = plan

  variables {
    monitoring = { ami_id = "ami-00000000000000000" }
  }

  expect_failures = [var.monitoring]
}

run "reject_monitoring_small_disk" {
  command = plan

  variables {
    monitoring = { ami_id = "ami-11111111111111111", root_volume_size_gb = 8 }
  }

  expect_failures = [var.monitoring]
}
