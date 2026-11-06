# The parameter is created by hand, not by Terraform: a managed SecureString, or a data source reading one,
# has its decrypted value copied into state on every refresh, whatever ignore_changes says
locals {
  openai_key_parameter     = "/${lower(var.app)}/${lower(var.env)}/openai-api-key"
  openai_key_parameter_arn = "arn:aws:ssm:eu-west-2:${data.aws_caller_identity.current.account_id}:parameter${local.openai_key_parameter}"
}

# A function of its own so only this role can read the OpenAI key, not the main API's
module "reword_lambda_function" {
  source                            = "terraform-aws-modules/lambda/aws"
  version                           = "7.21.1"
  function_name                     = "${lower(var.app)}_reword_${lower(var.env)}"
  description                       = "ListPal task reword (OpenAI)"
  handler                           = "reword.handler"
  runtime                           = "nodejs20.x"
  create_package                    = false
  local_existing_package            = "${path.module}/../src.zip"
  cloudwatch_logs_retention_in_days = 1
  publish                           = true
  attach_policy_json                = true
  # The AWS-managed aws/ssm key lets principals in the account decrypt through SSM, so no kms:Decrypt is needed
  policy_json = <<-EOT
    {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": "ssm:GetParameter",
                "Resource": "${local.openai_key_parameter_arn}"
            },
            {
                "Effect": "Allow",
                "Action": "dynamodb:UpdateItem",
                "Resource": "${module.dynamodb_table.dynamodb_table_arn}"
            }
        ]
    }
  EOT

  # The OpenAI call gives up at 6 s, so this leaves room for a cold start's SSM read
  timeout     = 10
  memory_size = 256

  environment_variables = {
    Env                = var.env
    OpenAIKeyParameter = local.openai_key_parameter
  }

  allowed_triggers = {
    AllowExecutionFromAPIGateway = {
      service    = "apigateway"
      source_arn = "${module.api_gateway.api_execution_arn}/*/POST/reword-task"
    }
  }

  tags = local.tags
}
