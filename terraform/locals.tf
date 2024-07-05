locals {
  lambda_routes = {
    all_tasks = {
      route   = "GET /all-tasks"
    },
    active_tasks = {
      route   = "GET /active-tasks"
    },
    expired_tasks = {
      route   = "GET /expired-tasks"
    },
    task = {
      route   = "GET /task"
    },
    boards = {
      route   = "GET /boards"
    }
  }

  apigateway_routes = {
    for k, v in local.lambda_routes :
    "${v.route}" => {
      integration = {
        uri                    = module.lambda_function[k].lambda_function_arn
        payload_format_version = "2.0"
      }
    }
  }
  
  tags = {
    Terraform   = "true"
    Environment = var.env
  }
}