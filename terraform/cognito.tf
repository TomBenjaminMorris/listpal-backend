resource "aws_cognito_user_pool" "this" {
  name                     = "${var.app}-${var.env}"
  alias_attributes         = ["email"]
  tags                     = local.tags
  auto_verified_attributes = ["email"]
  #   username_attributes      = ["email"]
  schema {
    attribute_data_type      = "String"
    developer_only_attribute = false
    mutable                  = true
    name                     = "email"
    required                 = true

    string_attribute_constraints {
      min_length = 1
      max_length = 256
    }
  }
  username_configuration {
    case_sensitive = false
  }
}

resource "aws_cognito_user_pool_domain" "main" {
  domain       = "listpal"
  user_pool_id = aws_cognito_user_pool.this.id
}

resource "aws_cognito_user_pool_client" "userpool_client" {
  name                                 = "client"
  user_pool_id                         = aws_cognito_user_pool.this.id
  callback_urls                        = ["https://example.com", "https://localhost", "http://localhost"] # This will need to be updated to include the real listpal endpoint once deployed
  supported_identity_providers         = ["COGNITO"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "aws.cognito.signin.user.admin"]
  explicit_auth_flows = [
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_CUSTOM_AUTH",
    "ALLOW_USER_SRP_AUTH"
  ]
}

resource "aws_cognito_user" "Tom" {
  user_pool_id = aws_cognito_user_pool.this.id
  username     = "Tom"
  password     = "Password123!"
  attributes = {
    email          = "tom@example.com"
    email_verified = true
  }
}

resource "aws_cognito_user" "Adam" {
  user_pool_id = aws_cognito_user_pool.this.id
  username     = "Adam"
  password     = "Password123!"
  attributes = {
    email          = "adam@example.com"
    email_verified = true
  }
}