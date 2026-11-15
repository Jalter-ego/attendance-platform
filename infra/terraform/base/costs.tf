# A2: presupuesto de toda la cuenta; una alerta avisa, no limita el gasto.
# Se habilita explícitamente en el archivo local de variables de la base.
resource "aws_budgets_budget" "account" {
  count = var.monthly_budget == null ? 0 : 1

  name         = "${var.project_name}-account-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget.amount_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = [80, 100]
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [var.monthly_budget.email]
    }
  }
}
