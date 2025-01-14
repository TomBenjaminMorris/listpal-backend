locals {
  # Cron schedule and description for weekly report
  weekly_report_cron = {
    schedule_expression = "cron(0 3 ? * MON *)"
    description         = "Fires every Monday at 3:00 AM"
  }

  # Lambda function environment variables
  lambda_env_vars = {
    Env                 = var.env,
    OPENAI_API_KEY_PATH = aws_ssm_parameter.openai_api_key.name
  }

  # Allowed triggers for the Lambda function
  weekly_report_allowed_triggers = {
    "AllowExecutionFromCloudWatchWeekly" = {
      principal  = "events.amazonaws.com"
      source_arn = aws_cloudwatch_event_rule.weekly_report.arn
    }
  }

  # Lambda execution policy
  lambda_execution_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:DescribeStream",
          "dynamodb:GetRecords",
          "dynamodb:GetShardIterator",
          "dynamodb:ListStreams",
          "dynamodb:Query",
          "dynamodb:PutItem"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_cloudwatch_event_rule" "weekly_report" {
  name                = "${lower(var.app)}_weekly_report_${lower(var.env)}"
  description         = local.weekly_report_cron.description
  schedule_expression = local.weekly_report_cron.schedule_expression
}

resource "aws_cloudwatch_event_target" "weekly_report_trigger_lambda_on_schedule" {
  depends_on = [aws_cloudwatch_event_rule.weekly_report]
  rule       = aws_cloudwatch_event_rule.weekly_report.name
  target_id  = "lambda"
  arn        = module.lambda_function_weekly_report.lambda_function_arn
}

resource "aws_lambda_permission" "weekly_report_allow_cloudwatch_to_call_split_lambda" {
  statement_id  = "AllowExecutionFromCloudWatchWeekly"
  action        = "lambda:InvokeFunction"
  function_name = module.lambda_function_weekly_report.lambda_function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.weekly_report.arn
}

module "lambda_function_weekly_report" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 7.0"

  function_name                     = "${lower(var.app)}_weekly_report_${lower(var.env)}"
  description                       = "ListPal Weekly Report"
  handler                           = "weekly_report_generator.handler"
  runtime                           = "nodejs20.x"
  create_package                    = false
  local_existing_package            = "${path.module}/../src.zip"
  cloudwatch_logs_retention_in_days = 1
  publish                           = true
  attach_policy_json                = true
  timeout                           = 20
  policy_json                       = local.lambda_execution_policy
  environment_variables             = local.lambda_env_vars
  allowed_triggers                  = local.weekly_report_allowed_triggers
  tags                              = local.tags
}

# Create the parameter in Parameter Store
resource "aws_ssm_parameter" "openai_api_key" {
  name        = "/listpal/${lower(var.env)}/openai_api_key"
  description = "API Key for OpenAI"
  type        = "SecureString"
  value       = "placeholder"
  tags        = local.tags

  lifecycle {
    ignore_changes = [
      value,
    ]
  }
}
