# locals {
#   weekly_report_crons = {
#     weekly = {
#       schedule_expression = "cron(0 0 ? * MON *)"
#       description         = "Fires every Monday"
#     },
#   }

#   weekly_report_allowed_triggers = {
#     for k, v in local.weekly_report_crons :
#     "AllowExecutionFromCloudWatch${title(k)}" => {
#       principal  = "events.amazonaws.com"
#       source_arn = aws_cloudwatch_event_rule.weekly_report[k].arn
#     }
#   }
# }

# resource "aws_cloudwatch_event_rule" "weekly_report" {
#   for_each = local.crons

#   name                = "${lower(var.app)}_${each.key}_score_reset"
#   description         = each.value.description
#   schedule_expression = each.value.schedule_expression
# }

# resource "aws_cloudwatch_event_target" "trigger_lambda_on_schedule" {
#   for_each = local.crons

#   depends_on = [aws_cloudwatch_event_rule.weekly_report]
#   rule       = aws_cloudwatch_event_rule.weekly_report[each.key].name
#   target_id  = "lambda"
#   arn        = module.lambda_function_reset.lambda_function_arn
# }

# resource "aws_lambda_permission" "allow_cloudwatch_to_call_split_lambda" {
#   for_each = local.crons

#   statement_id  = "AllowExecutionFromCloudWatch${title(each.key)}"
#   action        = "lambda:InvokeFunction"
#   function_name = module.lambda_function_reset.lambda_function_name
#   principal     = "events.amazonaws.com"
#   source_arn    = aws_cloudwatch_event_rule.weekly_report[each.key].arn
# }

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
  policy_json                       = <<-EOT
    {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": [
                    "dynamodb:DescribeStream",
                    "dynamodb:GetRecords",
                    "dynamodb:GetShardIterator",
                    "dynamodb:ListStreams",
                    "dynamodb:Query",
                    "dynamodb:PutItem"
                ],
                "Resource": "*"
            }
        ]
    }
  EOT

  environment_variables = {
    Env            = var.env,
    OPENAI_API_KEY = var.openai_api_key
  }

  # allowed_triggers = local.weekly_report_allowed_triggers
  tags = local.tags
}
