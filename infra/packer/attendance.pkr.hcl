# AMIs de rol para los tenants (frontend, backend, db) y para el servidor de monitoreo.
# Un solo `packer build .` construye las 4 en paralelo desde la misma base Ubuntu 24.04.
# Dentro de cada una, Ansible (modo local) instala lo que ese rol necesita: ver ../ansible/image.yml.

packer {
  required_version = ">= 1.11.0"

  required_plugins {
    amazon = {
      source  = "github.com/hashicorp/amazon"
      version = "~> 1.3"
    }
    ansible = {
      source  = "github.com/hashicorp/ansible"
      version = "~> 1.1"
    }
  }
}

locals {
  # Sin ":" ni espacios: los nombres de AMI no los aceptan.
  stamp = formatdate("YYYYMMDD-hhmm", timestamp())

  common_tags = {
    Project      = "attendance"
    ManagedBy    = "packer"
    ImageVersion = var.image_version
    GitCommit    = var.git_commit
    BackendRef   = var.backend_ref
    FrontendRef  = var.frontend_ref
    BuiltAt      = local.stamp
  }

  ansible_vars = {
    image_version = var.image_version
    git_commit    = var.git_commit
    backend_repo  = var.backend_repo
    backend_ref   = var.backend_ref
    frontend_repo = var.frontend_repo
    frontend_ref  = var.frontend_ref
    node_version  = var.node_version
    pnpm_version  = var.pnpm_version
  }
}

source "amazon-ebs" "ubuntu" {
  region        = var.region
  instance_type = var.build_instance_type
  ssh_username  = "ubuntu"

  source_ami_filter {
    filters = {
      name                = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"
      virtualization-type = "hvm"
      root-device-type    = "ebs"
    }
    owners      = ["099720109477"] # Canonical
    most_recent = true
  }

  launch_block_device_mappings {
    device_name           = "/dev/sda1"
    volume_size           = 12
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }

  # IMDSv2 obligatorio en la instancia de build y en las que salgan de la AMI.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  imds_support = "v2.0"

  run_tags = {
    Name      = "packer-build-attendance"
    Project   = "attendance"
    ManagedBy = "packer"
  }
}

build {
  name = "attendance"

  source "amazon-ebs.ubuntu" {
    name     = "frontend"
    ami_name = "attendance-frontend-${var.image_version}-${local.stamp}"
    tags     = merge(local.common_tags, { Name = "attendance-frontend-${var.image_version}", Role = "frontend" })
  }

  source "amazon-ebs.ubuntu" {
    name     = "backend"
    ami_name = "attendance-backend-${var.image_version}-${local.stamp}"
    tags     = merge(local.common_tags, { Name = "attendance-backend-${var.image_version}", Role = "backend" })
  }

  source "amazon-ebs.ubuntu" {
    name     = "db"
    ami_name = "attendance-db-${var.image_version}-${local.stamp}"
    tags     = merge(local.common_tags, { Name = "attendance-db-${var.image_version}", Role = "db" })
  }

  source "amazon-ebs.ubuntu" {
    name     = "monitoring"
    ami_name = "attendance-monitoring-${var.image_version}-${local.stamp}"
    tags     = merge(local.common_tags, { Name = "attendance-monitoring-${var.image_version}", Role = "monitoring" })
  }

  # Para construir solo un rol: packer build -only='attendance.amazon-ebs.backend' .

  provisioner "shell" {
    script          = "${path.root}/scripts/install-ansible.sh"
    execute_command = "chmod +x {{ .Path }}; sudo bash '{{ .Path }}'"
  }

  # Script de primer arranque que llama cloud-init (ver ../cloud-init/).
  provisioner "file" {
    source      = "${path.root}/../cloud-init/attendance-boot.sh"
    destination = "/tmp/attendance-boot"
  }

  provisioner "shell" {
    inline = ["sudo install -m 0755 -o root -g root /tmp/attendance-boot /usr/local/sbin/attendance-boot"]
  }

  provisioner "ansible-local" {
    playbook_file           = "${path.root}/../ansible/image.yml"
    playbook_dir            = "${path.root}/../ansible"
    staging_directory       = "/tmp/attendance-ansible"
    clean_staging_directory = true
    extra_arguments = concat(
      ["--become", "--extra-vars", "image_role=${source.name}"],
      flatten([for k, v in local.ansible_vars : ["--extra-vars", "${k}=${v}"]]),
    )
  }

  provisioner "shell" {
    script          = "${path.root}/scripts/cleanup.sh"
    execute_command = "chmod +x {{ .Path }}; sudo bash '{{ .Path }}'"
  }

  # ami-manifest.json: IDs de las AMIs que consume el IaC (Terraform/Tofu/Pulumi/CFN).
  post-processor "manifest" {
    output     = "${path.root}/ami-manifest.json"
    strip_path = true
    custom_data = {
      role          = source.name
      image_version = var.image_version
      git_commit    = var.git_commit
      backend_ref   = var.backend_ref
      frontend_ref  = var.frontend_ref
    }
  }
}
