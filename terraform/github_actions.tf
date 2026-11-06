locals {
  github_owner = "TomBenjaminMorris"

  # The site is managed by the frontend repo's own Terraform state, so these are looked up by alias rather than referenced
  frontend_bucket          = "www.listpal.dev.vinsp.in"
  frontend_distribution_id = "E1AKHSV400BS9K"
}

data "aws_caller_identity" "current" {}

# One per account. GitHub's certificate is trusted by AWS directly, so the thumbprints are only there because the API requires them.
resource "aws_iam_openid_connect_provider" "github_actions" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]

  tags = local.tags
}

locals {
  # Both repos are public, so each role names the exact repo and trigger it trusts. Fork PRs can't get a token at all.
  github_roles = {
    frontend_deploy = {
      name = "listpal-frontend-deploy"
      sub  = "repo:${local.github_owner}/listpal-frontend:ref:refs/heads/main"
    }
    backend_apply = {
      name = "listpal-backend-apply"
      sub  = "repo:${local.github_owner}/listpal-backend:ref:refs/heads/main"
    }
    backend_plan = {
      name = "listpal-backend-plan"
      sub  = "repo:${local.github_owner}/listpal-backend:pull_request"
    }
  }
}

resource "aws_iam_role" "github_actions" {
  for_each = local.github_roles

  name                 = each.value.name
  max_session_duration = 3600
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = aws_iam_openid_connect_provider.github_actions.arn }
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = each.value.sub
        }
      }
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy" "frontend_deploy" {
  name = "deploy-site"
  role = aws_iam_role.github_actions["frontend_deploy"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = "arn:aws:s3:::${local.frontend_bucket}"
      },
      {
        # No DeleteObject: old bundles stay for visitors still holding a cached index.html
        Effect   = "Allow"
        Action   = "s3:PutObject"
        Resource = "arn:aws:s3:::${local.frontend_bucket}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
        Resource = "arn:aws:cloudfront::${data.aws_caller_identity.current.account_id}:distribution/${local.frontend_distribution_id}"
      },
    ]
  })
}

# Terraform here manages IAM roles, so anything narrower would still be admin in practice. The main-branch trust is the real boundary.
resource "aws_iam_role_policy_attachment" "backend_apply" {
  role       = aws_iam_role.github_actions["backend_apply"].name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

resource "aws_iam_role_policy_attachment" "backend_plan" {
  role       = aws_iam_role.github_actions["backend_plan"].name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

resource "aws_iam_role_policy" "backend_plan" {
  name = "plan-extras"
  role = aws_iam_role.github_actions["backend_plan"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # A plan never needs user data or logged requests, which ReadOnlyAccess would otherwise expose to any PR branch
        Effect = "Deny"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:BatchGet*",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:PartiQL*",
          "dynamodb:Export*",
          "dynamodb:GetRecords",
          "dynamodb:ReadDataForReplication",
          "cognito-idp:ListUsers*",
          "cognito-idp:AdminGet*",
          "cognito-idp:AdminList*",
          "logs:GetLogEvents",
          "logs:GetLogRecord",
          "logs:FilterLogEvents",
          "logs:StartQuery",
          "logs:GetQueryResults",
          "logs:StartLiveTail",
        ]
        Resource = "*"
      },
      {
        # The plan reads only its own state. This keeps it out of other projects' states and any other bucket.
        Effect      = "Deny"
        Action      = "s3:GetObject*"
        NotResource = "arn:aws:s3:::tbm-tf-state-bucket/listpal-infra"
      },
    ]
  })
}
