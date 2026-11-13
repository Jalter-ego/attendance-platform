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
