resource "aws_ebs_volume" "db" {
  availability_zone = var.base.availability_zone
  size              = var.sizing.db_disk_gb
  type              = "gp3"
  encrypted         = true

  tags = { Name = "${local.resource_prefix}-pgdata", Role = "db" }
}

resource "aws_instance" "db" {
  ami                         = data.aws_ami.role["db"].id
  instance_type               = var.sizing.db
  subnet_id                   = var.base.private_subnet_id
  associate_public_ip_address = false
  vpc_security_group_ids      = [aws_security_group.role["db"].id]
  iam_instance_profile        = aws_iam_instance_profile.instance["db"].name
  user_data_replace_on_change = true
  user_data = local.template_exists ? templatefile(local.template_path, merge(local.boot_common, {
    role         = "db"
    db_volume_id = aws_ebs_volume.db.id
  })) : null

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 12
    encrypted             = true
    delete_on_termination = true
  }
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  tags = { Name = "${local.resource_prefix}-db", Role = "db" }

  depends_on = [terraform_data.prerequisites, aws_iam_role_policy.parameters, aws_vpc_security_group_egress_rule.outbound]
}

resource "aws_volume_attachment" "db" {
  device_name                    = "/dev/sdf"
  volume_id                      = aws_ebs_volume.db.id
  instance_id                    = aws_instance.db.id
  stop_instance_before_detaching = true
  force_detach                   = false
}

resource "aws_instance" "backend" {
  ami                         = data.aws_ami.role["backend"].id
  instance_type               = var.sizing.backend
  subnet_id                   = var.base.private_subnet_id
  associate_public_ip_address = false
  vpc_security_group_ids      = [aws_security_group.role["backend"].id]
  iam_instance_profile        = aws_iam_instance_profile.instance["backend"].name
  user_data_replace_on_change = true
  user_data = local.template_exists ? templatefile(local.template_path, merge(local.boot_common, {
    role    = "backend"
    db_host = aws_instance.db.private_ip
  })) : null

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 12
    encrypted             = true
    delete_on_termination = true
  }
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  tags = { Name = "${local.resource_prefix}-backend", Role = "backend" }

  depends_on = [terraform_data.prerequisites, aws_volume_attachment.db, aws_iam_role_policy.parameters, aws_vpc_security_group_egress_rule.outbound]
}

resource "aws_instance" "frontend" {
  ami                         = data.aws_ami.role["frontend"].id
  instance_type               = var.sizing.frontend
  subnet_id                   = var.base.public_subnet_id
  associate_public_ip_address = true
  vpc_security_group_ids      = [aws_security_group.role["frontend"].id]
  iam_instance_profile        = aws_iam_instance_profile.instance["frontend"].name
  user_data_replace_on_change = true
  user_data = local.template_exists ? templatefile(local.template_path, merge(local.boot_common, {
    role         = "frontend"
    backend_host = aws_instance.backend.private_ip
  })) : null

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 12
    encrypted             = true
    delete_on_termination = true
  }
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  tags = { Name = "${local.resource_prefix}-frontend", Role = "frontend" }

  depends_on = [terraform_data.prerequisites, aws_vpc_security_group_egress_rule.outbound]
}
