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

  # Otherwise Cognito applies a new email at once, and a typo locks the user out with no way to reset their password
  user_attribute_update_settings {
    attributes_require_verification_before_update = ["email"]
  }

  lambda_config {
    post_confirmation = module.sign_up_lambda_function.lambda_function_arn
  }
}

resource "aws_cognito_user_pool_domain" "custom_domain" {
  domain          = "auth.listpal.dev.${var.domain_name}"
  user_pool_id    = aws_cognito_user_pool.this.id
  certificate_arn = aws_acm_certificate.login_cert.arn
  # CURRENTLY I NEED TO ENABLE THE NEW MANAGED LOGIN IN THE AWS CONSOLE AFTER THIS RESOURCE IS CREATED:
  # https://eu-west-2.console.aws.amazon.com/cognito/v2/idp/user-pools/eu-west-2_CwBCZpR9j/branding/domain?region=eu-west-2
}

resource "aws_cognito_user_pool_client" "userpool_client" {
  name                                 = "client"
  user_pool_id                         = aws_cognito_user_pool.this.id
  callback_urls                        = ["http://localhost:5173/redirect", "https://listpal.dev.vinsp.in/redirect"]
  supported_identity_providers         = ["COGNITO"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  # The admin scope lets the access token call Cognito's self-service operations, such as ChangePassword, from Settings
  allowed_oauth_scopes = ["openid", "aws.cognito.signin.user.admin"]
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

  # Details edited in Settings would otherwise be reverted by the next apply
  lifecycle {
    ignore_changes = [attributes]
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

  # Details edited in Settings would otherwise be reverted by the next apply
  lifecycle {
    ignore_changes = [attributes]
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

  # Details edited in Settings would otherwise be reverted by the next apply
  lifecycle {
    ignore_changes = [attributes]
  }
}
