data "archive_file" "api_lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../src"
  output_path = "${path.module}/../src.zip"
}

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
  environment_variables = {
    Env      = var.env
  }
  allowed_triggers = {
    AllowExecutionFromAPIGateway = {
      service    = "apigateway"
      source_arn = "${module.api_gateway.api_execution_arn}/*/*"
    }
  }
  tags = local.tags
}
