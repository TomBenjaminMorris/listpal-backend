locals {
  lambda_routes = {
    all_tasks = {
      route     = "GET /all-tasks"
      protected = true
    },
    active_tasks = {
      route     = "GET /active-tasks"
      protected = true
    },
    expired_tasks = {
      route     = "GET /expired-tasks"
      protected = true
    },
    task = {
      route     = "GET /task"
      protected = true
    },
    boards = {
      route     = "GET /boards"
      protected = true
    },
    user = {
      route     = "GET /user"
      protected = true
    },
    task_description = {
      route     = "POST /task-description"
      protected = true
    },
    task_details = {
      route     = "POST /task-details"
      protected = true
    },
    new_task = {
      route     = "POST /new-task"
      protected = true
    },
    delete_task = {
      route     = "POST /delete-task"
      protected = true
    }
  }

  apigateway_routes = {
    for k, v in local.lambda_routes :
    "${v.route}" => {
      authorization_type   = v.protected ? "JWT" : "NONE"
      authorizer_key       = v.protected ? "cognito" : ""
      authorization_scopes = v.protected ? ["aws.cognito.signin.user.admin"] : []

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
