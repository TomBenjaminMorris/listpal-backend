resource "aws_cognito_user_pool" "this" {
  name                     = "${var.app}-${var.env}"
  tags                     = local.tags
  auto_verified_attributes = ["email"]
  username_attributes      = ["email"]

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
  domain       = "${lower(var.app)}-${lower(var.env)}"
  user_pool_id = aws_cognito_user_pool.this.id
}

resource "aws_cognito_user_pool_client" "userpool_client" {
  name                                 = "client"
  user_pool_id                         = aws_cognito_user_pool.this.id
  callback_urls                        = ["http://localhost:5173/redirect", "https://listpal.dev.vinsp.in/redirect"]
  supported_identity_providers         = ["COGNITO"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid"]
  explicit_auth_flows = [
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_CUSTOM_AUTH",
    "ALLOW_USER_SRP_AUTH"
  ]
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

resource "aws_cognito_user" "Admin" {
  user_pool_id = aws_cognito_user_pool.this.id
  username     = "admin@example.com"
  password     = "Password123!"
  attributes = {
    email          = "admin@example.com"
    email_verified = true
    given_name     = "Admin"
    family_name    = "User"
  }
}

resource "aws_cognito_user" "Tom" {
  user_pool_id = aws_cognito_user_pool.this.id
  username     = "tom@example.com"
  password     = "Password123!"
  attributes = {
    email          = "tom@example.com"
    email_verified = true
    given_name     = "Tom"
    family_name    = "Morris"
  }
}

resource "aws_cognito_user" "Adam" {
  user_pool_id = aws_cognito_user_pool.this.id
  username     = "adam@example.com"
  password     = "Password123!"
  attributes = {
    email          = "adam@example.com"
    email_verified = true
    given_name     = "Adam"
    family_name    = "Cooper"
  }
}
