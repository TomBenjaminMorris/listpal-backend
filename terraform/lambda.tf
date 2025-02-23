data "archive_file" "api_lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../src"
  output_path = "${path.module}/../src.zip"
}

module "lambda_function" {
  source                            = "terraform-aws-modules/lambda/aws"
  version                           = "~> 7.0"
  function_name                     = "${lower(var.app)}_${lower(var.env)}"
  description                       = "ListPal API endpoint"
  handler                           = "handler.handler"
  runtime                           = "nodejs20.x"
  create_package                    = false
  local_existing_package            = "${path.module}/../src.zip"
  cloudwatch_logs_retention_in_days = 1
  publish                           = true
  attach_policy_json                = true
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
                    "dynamodb:UpdateItem",
                    "dynamodb:PutItem",
                    "dynamodb:DeleteItem"
                ],
                "Resource": "*"
            }
        ]
    }
  EOT

  environment_variables = {
    Env = var.env
  }

  allowed_triggers = {
    AllowExecutionFromAPIGateway = {
      service    = "apigateway"
      source_arn = "${module.api_gateway.api_execution_arn}/*/*"
    }
  }

  tags = local.tags
}
