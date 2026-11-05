locals {
  monitored_lambdas = {
    api         = module.lambda_function
    reword      = module.reword_lambda_function
    score_reset = module.lambda_function_reset
  }
}

resource "aws_sns_topic" "alerts" {
  name = "${lower(var.app)}_alerts_${lower(var.env)}"
  tags = local.tags
}

# Stays pending until the link in AWS's confirmation email is clicked
resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# The handlers catch their errors and return 500, so Lambda's own Errors metric only sees timeouts and crashes.
# Counting logged errors as well catches failures the caller sees, such as OpenAI being down.
resource "aws_cloudwatch_log_metric_filter" "lambda_errors" {
  for_each = local.monitored_lambdas

  name           = "${each.key}_errors"
  log_group_name = each.value.lambda_cloudwatch_log_group_name
  pattern        = "?ERROR ?\"Task timed out\" ?\"Runtime exited\""

  metric_transformation {
    name      = "${each.key}_lambda_errors"
    namespace = var.app
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = local.monitored_lambdas

  alarm_name        = "${each.value.lambda_function_name}_errors"
  alarm_description = "${each.value.lambda_function_name} logged an error. Its logs are kept for 1 day."
  namespace         = var.app
  metric_name       = aws_cloudwatch_log_metric_filter.lambda_errors[each.key].metric_transformation[0].name
  statistic         = "Sum"
  period            = 300
  # One email per burst of errors: the alarm clears after a quiet 5 minutes and fires again on the next error
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  # The filter publishes nothing when no errors are logged
  treat_missing_data = "notBreaching"
  alarm_actions      = [aws_sns_topic.alerts.arn]

  tags = local.tags
}

# Covers the whole AWS account, not only ListPal. Budgets email directly, so this doesn't use the SNS topic.
resource "aws_budgets_budget" "monthly_cost" {
  name         = "Monthly cost"
  budget_type  = "COST"
  limit_amount = "2.0"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Early warning: the forecast is normally under $1, so passing it means costs are rising
  notification {
    notification_type          = "FORECASTED"
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    notification_type          = "FORECASTED"
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    notification_type          = "ACTUAL"
    comparison_operator        = "GREATER_THAN"
    threshold                  = 85
    threshold_type             = "PERCENTAGE"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    notification_type          = "ACTUAL"
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    subscriber_email_addresses = [var.alert_email]
  }

  tags = local.tags
}
