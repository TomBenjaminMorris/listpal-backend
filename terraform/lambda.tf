locals {
  lambda_routes = {
    all_tasks = {
      handler = "index.lambda_handler"
      route   = "GET /all-tasks"
    },
    active_tasks = {
      handler = "index.lambda_handler"
      route   = "GET /active-tasks"
    },
    expired_tasks = {
      handler = "index.lambda_handler"
      route   = "GET /expired-tasks"
    },
    task = {
      handler = "index.lambda_handler"
      route   = "GET /task"
    },
    boards = {
      handler = "index.lambda_handler"
      route   = "GET /boards"
    }
  }
}

data "archive_file" "api_lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../src"
  output_path = "${path.module}/../src.zip"
}

# https://registry.terraform.io/modules/terraform-aws-modules/lambda/aws/latest
# https://github.com/terraform-aws-modules/terraform-aws-lambda/blob/master/examples/complete/main.tf
# https://github.com/terraform-aws-modules/terraform-aws-lambda/blob/master/examples/async/main.tf
# https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_function#argument-reference
module "lambda_function" {
  source                            = "terraform-aws-modules/lambda/aws"
  version                           = "~> 7.0"
  for_each                          = local.lambda_routes
  function_name                     = "${lower(var.app)}_${each.key}_${lower(var.env)}"
  description                       = "My awesome lambda function"
  handler                           = "handler.handler"
  runtime                           = "nodejs20.x"
  create_package                    = false
  local_existing_package            = "${path.module}/../src.zip"
  attach_policies                   = true
  policies                          = ["arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess"] // LIMIT THIS ACCESS!
  number_of_policies                = 1
  cloudwatch_logs_retention_in_days = 1
  allowed_triggers = {
    AllowExecutionFromAPIGateway = {
      service    = "apigateway"
      source_arn = "${module.api_gateway.api_execution_arn}/*/*"
    }
  }
  tags = local.tags
}
