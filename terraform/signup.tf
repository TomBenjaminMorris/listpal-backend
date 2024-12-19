module "sign_up_lambda_function" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 7.0"

  function_name                     = "${lower(var.app)}_sign_up_${lower(var.env)}"
  description                       = "ListPal Sign-Up Function"
  handler                           = "sign_up.handler"
  runtime                           = "nodejs20.x"
  create_package                    = false
  local_existing_package            = "${path.module}/../src.zip"
  cloudwatch_logs_retention_in_days = 1
  publish                           = true
  timeout                           = 10

  environment_variables = {
    Env = var.env
  }

  tags = local.tags
}

resource "aws_lambda_permission" "allow_cognito" {
  statement_id  = "AllowCognitoInvoke"
  action        = "lambda:InvokeFunction"
  function_name = module.sign_up_lambda_function.lambda_function_name
  principal     = "cognito-idp.amazonaws.com"
}
