locals {
  lambda_routes = {
    # all_tasks = {
    #   route     = "GET /all-tasks"
    #   protected = true
    # },
    active_tasks = {
      route     = "GET /active-tasks"
      protected = true
    },
    # expired_tasks = {
    #   route     = "GET /expired-tasks"
    #   protected = true
    # },
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
    weekly_reports = {
      route     = "GET /weekly-reports"
      protected = true
    },
    stats = {
      route     = "GET /stats"
      protected = true
    },
    new_user = {
      route     = "POST /new-user"
      protected = false
    },
    task_sync = {
      route     = "POST /task-sync"
      protected = true
    },
    # task_description = {
    #   route     = "POST /task-description"
    #   protected = true
    # },
    # task_details = {
    #   route     = "POST /task-details"
    #   protected = true
    # },
    # task_checked = {
    #   route     = "POST /task-checked"
    #   protected = true
    # },
    # task_important = {
    #   route     = "POST /task-important"
    #   protected = true
    # },
    # new_task = {
    #   route     = "POST /new-task"
    #   protected = true
    # },
    # delete_task = {
    #   route     = "POST /delete-task"
    #   protected = true
    # },
    rename_category = {
      route     = "POST /rename-category"
      protected = true
    },
    user_theme = {
      route     = "POST /user-theme"
      protected = true
    },
    new_board = {
      route     = "POST /new-board"
      protected = true
    },
    rename_board = {
      route     = "POST /rename-board"
      protected = true
    },
    card_emoji = {
      route     = "POST /card-emoji"
      protected = true
    },
    board_emoji = {
      route     = "POST /board-emoji"
      protected = true
    },
    board_category_order = {
      route     = "POST /board-category-order"
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
    board_targets = {
      route     = "POST /board-targets"
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
