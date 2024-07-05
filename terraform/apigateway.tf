locals { # try to template this block using https://developer.hashicorp.com/terraform/language/functions/templatefile
  apigateway_routes = {
    "GET /all-tasks" = {
      integration = {
        uri                    = module.lambda_function["all_tasks"].lambda_function_arn
        payload_format_version = "2.0"
      }
    },
    "GET /active-tasks" = {
      integration = {
        uri                    = module.lambda_function["active_tasks"].lambda_function_arn
        payload_format_version = "2.0"
      }
    },
    "GET /expired-tasks" = {
      integration = {
        uri                    = module.lambda_function["expired_tasks"].lambda_function_arn
        payload_format_version = "2.0"
      }
    },
    "GET /task" = {
      integration = {
        uri                    = module.lambda_function["task"].lambda_function_arn
        payload_format_version = "2.0"
      }
    },
    "GET /boards" = {
      integration = {
        uri                    = module.lambda_function["boards"].lambda_function_arn
        payload_format_version = "2.0"
      }
    }
  }
}

# https://github.com/terraform-aws-modules/terraform-aws-apigateway-v2/blob/master/examples/complete-http/main.tf
module "api_gateway" {
  source  = "terraform-aws-modules/apigateway-v2/aws"
  version = "5.0.0"

  name          = "${var.app}-${var.env}"
  protocol_type = "HTTP"

  cors_configuration = {
    allow_headers = ["content-type", "x-amz-date", "authorization", "x-api-key", "x-amz-security-token", "x-amz-user-agent"]
    allow_methods = ["*"]
    allow_origins = ["*"]
  }

  create_domain_name = false

  create_domain_records = true
  create_certificate    = true

  stage_access_log_settings = {
    create_log_group            = true
    log_group_retention_in_days = 1
    format = jsonencode({
      context = {
        domainName              = "$context.domainName"
        integrationErrorMessage = "$context.integrationErrorMessage"
        protocol                = "$context.protocol"
        requestId               = "$context.requestId"
        requestTime             = "$context.requestTime"
        responseLength          = "$context.responseLength"
        routeKey                = "$context.routeKey"
        stage                   = "$context.stage"
        status                  = "$context.status"
        error = {
          message      = "$context.error.message"
          responseType = "$context.error.responseType"
        }
        identity = {
          sourceIP = "$context.identity.sourceIp"
        }
        integration = {
          error             = "$context.integration.error"
          integrationStatus = "$context.integration.integrationStatus"
        }
      }
    })
  }

  routes = local.apigateway_routes

  stage_default_route_settings = {
    detailed_metrics_enabled = false
    throttling_burst_limit   = 10
    throttling_rate_limit    = 10
  }

  tags = local.tags
}