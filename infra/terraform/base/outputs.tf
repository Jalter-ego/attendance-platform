output "integration" {
  description = "Configuracion compartida que consumiran P2/P3/P5/P6; contiene IDs, no secretos."
  value = {
    project_name                     = var.project_name
    region                           = var.aws_region
    availability_zone                = local.availability_zone
    vpc_id                           = aws_vpc.platform.id
    public_subnet_id                 = aws_subnet.public.id
    private_subnet_id                = aws_subnet.private.id
    packer_security_group_id         = aws_security_group.packer.id
    monitoring_security_group_id     = aws_security_group.monitoring.id
    monitoring_instance_profile_name = aws_iam_instance_profile.monitoring.name
    ssm_endpoint_id                  = aws_vpc_endpoint.ssm.id
  }

  depends_on = [
    aws_route.internet,
    aws_route_table_association.public,
    aws_route_table_association.private,
    aws_iam_role_policy.monitoring_discovery,
  ]
}
