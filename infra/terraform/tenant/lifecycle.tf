resource "aws_ec2_instance_state" "app" {
  for_each = {
    frontend = aws_instance.frontend.id
    backend  = aws_instance.backend.id
    db       = aws_instance.db.id
  }

  instance_id = each.value
  state       = var.suspended ? "stopped" : "running"
  force       = false

  depends_on = [aws_volume_attachment.db]
}

# aws_instance puede haberse refrescado antes del StartInstances. Leer otra vez
# despues del cambio de estado evita publicar la IP anterior al reanudar.
data "aws_instance" "frontend_runtime" {
  instance_id = aws_instance.frontend.id

  depends_on = [aws_ec2_instance_state.app]
}
