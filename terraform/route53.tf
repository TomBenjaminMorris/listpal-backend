data "aws_route53_zone" "main" {
  name = var.root_domain_zone
}

resource "aws_route53_record" "cognito_custom_domain" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "auth.listpal.dev.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_cognito_user_pool_domain.custom_domain.cloudfront_distribution
    zone_id                = aws_cognito_user_pool_domain.custom_domain.cloudfront_distribution_zone_id
    evaluate_target_health = false
  }
}
