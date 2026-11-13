mock_provider "aws" {
  override_during = plan

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }

  mock_resource "aws_s3_bucket" {
    defaults = {
      id  = "attendance-platform-tfstate-123456789012"
      arn = "arn:aws:s3:::attendance-platform-tfstate-123456789012"
    }
  }
}

run "state_security" {
  command = plan

  assert {
    condition     = aws_s3_bucket.state.bucket == "attendance-platform-tfstate-123456789012" && !aws_s3_bucket.state.force_destroy
    error_message = "El bucket debe pertenecer a este proyecto/cuenta y no permitir vaciar sus objetos al destruirlo."
  }

  assert {
    condition = (
      aws_s3_bucket_public_access_block.state.block_public_acls &&
      aws_s3_bucket_public_access_block.state.block_public_policy &&
      aws_s3_bucket_public_access_block.state.ignore_public_acls &&
      aws_s3_bucket_public_access_block.state.restrict_public_buckets
    )
    error_message = "Deben estar activas las cuatro protecciones de acceso público."
  }

  assert {
    condition     = aws_s3_bucket_versioning.state.versioning_configuration[0].status == "Enabled"
    error_message = "El estado necesita versionado para recuperar versiones anteriores."
  }

  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.state.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "AES256"
    error_message = "Los objetos deben cifrarse en S3."
  }

  assert {
    condition     = aws_s3_bucket_ownership_controls.state.rule[0].object_ownership == "BucketOwnerEnforced"
    error_message = "La propiedad de los objetos debe permanecer en la cuenta dueña del bucket."
  }

  assert {
    condition = (
      jsondecode(aws_s3_bucket_policy.state.policy).Statement[0].Effect == "Deny" &&
      jsondecode(aws_s3_bucket_policy.state.policy).Statement[0].Condition.Bool["aws:SecureTransport"] == "false" &&
      jsondecode(aws_s3_bucket_policy.state.policy).Statement[0].Resource[1] == "arn:aws:s3:::attendance-platform-tfstate-123456789012/*"
    )
    error_message = "La política debe rechazar el transporte inseguro tanto para el bucket como para sus objetos."
  }

  assert {
    condition     = output.bootstrap_backend.key == "platform/bootstrap/terraform.tfstate" && output.bootstrap_backend.use_lockfile && output.bootstrap_backend.encrypt
    error_message = "El backend de bootstrap debe tener su propia clave, cifrado y bloqueo."
  }
}

run "invalid_project_name" {
  command = plan

  variables {
    project_name = "Nombre con espacios"
  }

  expect_failures = [var.project_name]
}
