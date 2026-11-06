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
      protected = true
    },
    sync = {
      route     = "POST /sync"
      protected = true
    },
    user_theme = {
      route     = "POST /user-theme"
      protected = true
    },
    user_reword_tone = {
      route     = "POST /user-reword-tone"
      protected = true
    },
    user_ai_enabled = {
      route     = "POST /user-ai-enabled"
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
    },
    reword_task = {
      route     = "POST /reword-task"
      protected = true
      lambda    = "reword"
      # Each request is a paid OpenAI call, so this route gets far less than the stage default
      throttling_rate_limit  = 2
      throttling_burst_limit = 5
    }
  }

  route_lambdas = {
    api    = module.lambda_function.lambda_function_arn
    reword = module.reword_lambda_function.lambda_function_arn
  }

  apigateway_routes = {
    for k, v in local.lambda_routes :
    "${v.route}" => {
      authorization_type   = v.protected ? "JWT" : "NONE"
      authorizer_key       = v.protected ? "cognito" : ""
      authorization_scopes = v.protected ? ["openid"] : []
      # null falls back to the stage default
      throttling_rate_limit  = try(v.throttling_rate_limit, null)
      throttling_burst_limit = try(v.throttling_burst_limit, null)

      integration = {
        uri                    = local.route_lambdas[try(v.lambda, "api")]
        payload_format_version = "2.0"
      }
    }
  }

  tags = {
    Terraform   = "true"
    Environment = var.env
  }
}
