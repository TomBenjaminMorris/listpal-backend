locals {
  lambda_routes = {
    active_tasks = {
      route     = "GET /active-tasks"
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
    new_user = {
      route     = "POST /new-user"
      protected = false
    },
    sync = {
      route     = "POST /sync"
      protected = true
    },
    user_theme = {
      route     = "POST /user-theme"
      protected = true
    },
    delete_board = {
      route     = "POST /delete-board"
      protected = true
    },
    board_scores = {
      route     = "POST /board-scores"
      protected = true
    },
    delete_account = {
      route     = "POST /delete-account"
      protected = true
    }
  }

  apigateway_routes = {
    for k, v in local.lambda_routes :
    "${v.route}" => {
      authorization_type   = v.protected ? "JWT" : "NONE"
      authorizer_key       = v.protected ? "cognito" : ""
      authorization_scopes = v.protected ? ["openid"] : []

      integration = {
        uri                    = module.lambda_function.lambda_function_arn
        payload_format_version = "2.0"
      }
    }
  }

  tags = {
    Terraform   = "true"
    Environment = var.env
  }
}
