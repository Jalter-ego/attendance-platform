resource "aws_security_group" "role" {
  for_each    = local.roles
  name_prefix = "${local.resource_prefix}-${each.key}-"
  description = "Attendance ${var.tenant_id}/${var.env}: ${each.key}"
  vpc_id      = var.base.vpc_id

  tags = { Name = "${local.resource_prefix}-${each.key}", Role = each.key }
}

resource "aws_vpc_security_group_ingress_rule" "frontend_http" {
  security_group_id = aws_security_group.role["frontend"].id
  description       = "Navegador hacia nginx"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "backend_api" {
  security_group_id            = aws_security_group.role["backend"].id
  description                  = "Solo el proxy de este tenant"
  referenced_security_group_id = aws_security_group.role["frontend"].id
  ip_protocol                  = "tcp"
  from_port                    = 5000
  to_port                      = 5000
}

resource "aws_vpc_security_group_ingress_rule" "database" {
  security_group_id            = aws_security_group.role["db"].id
  description                  = "Solo el backend de este tenant"
  referenced_security_group_id = aws_security_group.role["backend"].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

locals {
  exporters = {
    for pair in setproduct(local.roles, toset([9100, 9256, 8889, 19999])) :
    "${pair[0]}-${pair[1]}" => { role = pair[0], port = pair[1] }
  }
}

resource "aws_vpc_security_group_ingress_rule" "exporter" {
  for_each                     = local.exporters
  security_group_id            = aws_security_group.role[each.value.role].id
  description                  = "Exporters solo desde monitoreo compartido"
  referenced_security_group_id = var.base.monitoring_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
}

resource "aws_vpc_security_group_ingress_rule" "backend_metrics" {
  security_group_id            = aws_security_group.role["backend"].id
  description                  = "Monitoreo de la API; P4/P5 definen la ruta de metricas"
  referenced_security_group_id = var.base.monitoring_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 5000
  to_port                      = 5000
}

resource "aws_vpc_security_group_egress_rule" "outbound" {
  for_each          = local.roles
  security_group_id = aws_security_group.role[each.key].id
  description       = "Salida sujeta a las rutas y a los SG de destino"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
