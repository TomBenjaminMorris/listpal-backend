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

  routes = local.routes

  stage_default_route_settings = {
    detailed_metrics_enabled = false
    throttling_burst_limit   = 10
    throttling_rate_limit    = 10
  }

  tags = local.tags
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
  allowed_triggers = {
    AllowExecutionFromAPIGateway = {
      service    = "apigateway"
      source_arn = "${module.api_gateway.api_execution_arn}/*/*"
    }
  }
  tags = local.tags
}

# module "lambda_function" {
#   source   = "terraform-aws-modules/lambda/aws"
#   version  = "~> 7.0"
#   for_each = local.lambda_routes

#   function_name = "${lower(var.app)}_${each.key}_${lower(var.env)}"
#   description   = "My awesome lambda function"
#   # handler       = each.value["handler"]
#   handler = "handler.handler"
#   # runtime       = "python3.12"
#   runtime       = "nodejs20.x"
#   architectures = ["arm64"]
#   publish       = true

#   # store_on_s3 = true
#   # s3_existing_package = {
#   #   bucket     = module.s3_bucket.s3_bucket_id
#   #   key        = "src.zip"
#   #   version_id = null
#   # }

#   source_path = "${path.module}/../lambda_src"

#   # create_package = false
#   # local_existing_package = local.downloaded

#   cloudwatch_logs_retention_in_days = 1

#   allowed_triggers = {
#     AllowExecutionFromAPIGateway = {
#       service    = "apigateway"
#       source_arn = "${module.api_gateway.api_execution_arn}/*/*"
#     }
#   }

#   policies           = ["arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess"]
#   attach_policies    = true

#   hash_extra  = data.archive_file.api_lambda.output_base64sha256

#   tags = local.tags
# }

# resource "null_resource" "download_package" {
#   triggers = {
#     downloaded = local.downloaded
#   }

#   provisioner "local-exec" {
#     command = "curl -L -o ${local.downloaded} ${local.package_url}"
#   }
# }

locals {
  # package_url = "https://raw.githubusercontent.com/terraform-aws-modules/terraform-aws-lambda/master/examples/fixtures/python-function.zip"
  # downloaded  = "downloaded_package_${md5(local.package_url)}.zip"

  tags = {
    Terraform   = "true"
    Environment = var.env
  }

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

  #   routes = { for key, val in local.lambda_routes : val.route => val }
  routes = {
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