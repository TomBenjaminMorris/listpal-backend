data "archive_file" "api_lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../src"
  output_path = "${path.module}/../src.zip"
}

module "lambda_function" {
  source         = "terraform-aws-modules/lambda/aws"
  version        = "7.17.0"
  function_name  = "${lower(var.app)}_${lower(var.env)}"
  description    = "ListPal API endpoint"
  handler        = "handler.handler"
  runtime        = "nodejs22.x"
  create_package = false
  # Referencing the data source builds the zip first. A plain path is hashed before the zip exists on a fresh checkout, so CI would miss code changes.
  local_existing_package            = data.archive_file.api_lambda.output_path
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
                    "dynamodb:GetItem",
                    "dynamodb:UpdateItem",
                    "dynamodb:PutItem",
                    "dynamodb:DeleteItem",
                    "dynamodb:BatchWriteItem"
                ],
                "Resource": "*"
            },
            {
                "Effect": "Allow",
                "Action": "cognito-idp:AdminDeleteUser",
                "Resource": "${aws_cognito_user_pool.this.arn}"
            }
        ]
    }
  EOT

  # A /sync batch of 50 ops runs one after another, which can outlast the 3 s default at 128 MB.
  # A timed-out batch would be resent whole and could time out on every retry.
  timeout = 15
  # CPU scales with memory; SDK start-up and item marshalling are CPU-bound, so this shortens cold starts and syncs
  memory_size = 1024

  environment_variables = {
    Env        = var.env
    UserPoolId = aws_cognito_user_pool.this.id
  }

  allowed_triggers = {
    AllowExecutionFromAPIGateway = {
      service    = "apigateway"
      source_arn = "${module.api_gateway.api_execution_arn}/*/*"
    }
  }

  tags = local.tags
}
