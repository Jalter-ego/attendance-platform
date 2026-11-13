resource "aws_security_group" "packer" {
  name_prefix = "${var.project_name}-packer-"
  description = "Acceso al constructor temporal de imagenes Packer"
  vpc_id      = aws_vpc.platform.id

  tags = {
    Name = "${var.project_name}-packer"
    Role = "image-builder"
  }
}

resource "aws_vpc_security_group_ingress_rule" "packer_ssh" {
  for_each = var.operator_cidrs

  security_group_id = aws_security_group.packer.id
  description       = "SSH desde una conexion autorizada para construir imagenes"
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_vpc_security_group_egress_rule" "packer" {
  security_group_id = aws_security_group.packer.id
  description       = "Descargas necesarias para construir la AMI"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "monitoring" {
  name_prefix = "${var.project_name}-monitoring-"
  description = "Acceso al futuro servidor compartido de monitoreo"
  vpc_id      = aws_vpc.platform.id

  tags = {
    Name = "${var.project_name}-monitoring"
    Role = "monitoring"
  }
}

resource "aws_vpc_security_group_ingress_rule" "monitoring_ssh" {
  for_each = var.operator_cidrs

  security_group_id = aws_security_group.monitoring.id
  description       = "SSH de administracion desde una conexion autorizada"
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_vpc_security_group_ingress_rule" "grafana" {
  for_each = var.operator_cidrs

  security_group_id = aws_security_group.monitoring.id
  description       = "Grafana desde una conexion autorizada"
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 3000
  to_port           = 3000
}

resource "aws_vpc_security_group_egress_rule" "monitoring" {
  security_group_id = aws_security_group.monitoring.id
  description       = "Consultas a AWS y a los exporters de los tenants"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
