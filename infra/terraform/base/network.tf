locals {
  availability_zone = data.aws_availability_zones.available.names[0]
}

resource "aws_vpc" "platform" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.project_name}-vpc" }
}

resource "aws_internet_gateway" "platform" {
  vpc_id = aws_vpc.platform.id

  tags = { Name = "${var.project_name}-igw" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.platform.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, 1)
  availability_zone       = local.availability_zone
  map_public_ip_on_launch = false

  tags = { Name = "${var.project_name}-public" }
}

resource "aws_subnet" "private" {
  vpc_id                  = aws_vpc.platform.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, 2)
  availability_zone       = local.availability_zone
  map_public_ip_on_launch = false

  tags = { Name = "${var.project_name}-private" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.platform.id

  tags = { Name = "${var.project_name}-public" }
}

resource "aws_route" "internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.platform.id
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# La subred privada solo tiene la ruta local. SSM se alcanza mediante PrivateLink.
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.platform.id

  tags = { Name = "${var.project_name}-private" }
}

resource "aws_route_table_association" "private" {
  subnet_id      = aws_subnet.private.id
  route_table_id = aws_route_table.private.id
}
