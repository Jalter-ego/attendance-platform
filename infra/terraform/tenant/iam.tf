resource "aws_iam_role" "instance" {
  for_each = local.roles
  name     = "${local.resource_prefix}-${each.key}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })

  tags = { Role = each.key }
}

# El frontend no lee secretos. P3 lee el prefijo completo en backend y DB.
resource "aws_iam_role_policy" "parameters" {
  for_each = toset(["backend", "db"])
  name     = "tenant-parameters"
  role     = aws_iam_role.instance[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssm:GetParametersByPath", "ssm:GetParameters"]
      Resource = [local.ssm_arn, "${local.ssm_arn}/*"]
    }]
  })
}

resource "aws_iam_instance_profile" "instance" {
  for_each = local.roles
  name     = aws_iam_role.instance[each.key].name
  role     = aws_iam_role.instance[each.key].name

  tags = { Role = each.key }
}
