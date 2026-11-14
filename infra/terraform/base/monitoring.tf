# P3 construye la imagen; P5 aporta descubrimiento, dashboards y alertas.
# El ID se fija en las variables para no reemplazar la EC2 al publicar otra AMI.
data "aws_ami" "monitoring" {
  count  = var.monitoring == null ? 0 : 1
  owners = ["self"]

  filter {
    name   = "image-id"
    values = [var.monitoring.ami_id]
  }
  filter {
    name   = "tag:Role"
    values = ["monitoring"]
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

resource "aws_instance" "monitoring" {
  count = var.monitoring == null ? 0 : 1

  ami                         = data.aws_ami.monitoring[0].id
  instance_type               = var.monitoring.instance_type
  subnet_id                   = aws_subnet.public.id
  associate_public_ip_address = true
  vpc_security_group_ids      = [aws_security_group.monitoring.id]
  iam_instance_profile        = aws_iam_instance_profile.monitoring.name
  user_data_replace_on_change = true
  # Sin descargas: los tres servicios ya vienen instalados en Ubuntu/P3.
  user_data = "#cloud-config\n${yamlencode({
    runcmd = [
      ["systemctl", "enable", "--now", "prometheus", "grafana-server"],
      ["systemctl", "enable", "--now", "snap.amazon-ssm-agent.amazon-ssm-agent.service"],
    ]
  })}"

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.monitoring.root_volume_size_gb
    encrypted             = true
    delete_on_termination = true
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  credit_specification {
    cpu_credits = "standard"
  }

  tags = { Name = "${var.project_name}-monitoring", Role = "monitoring" }

  depends_on = [
    aws_route.internet,
    aws_route_table_association.public,
    aws_iam_role_policy.monitoring_discovery,
    aws_iam_role_policy.monitoring_ssm_agent,
    aws_vpc_security_group_egress_rule.monitoring,
    aws_vpc_endpoint.ssm,
    aws_vpc_endpoint.ssm_agent,
  ]
}

locals {
  monitoring_public_ip = one(aws_instance.monitoring[*].public_ip)
}
