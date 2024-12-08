resource "aws_acm_certificate" "login_cert" {
  domain_name       = "auth.listpal.dev.${var.domain_name}"
  validation_method = "DNS"
  provider          = aws.use1

  subject_alternative_names = ["listpal.dev.${var.domain_name}", "www.listpal.dev.${var.domain_name}", "auth.listpal.dev.${var.domain_name}", "www.auth.listpal.dev.${var.domain_name}"]

  validation_option {
    domain_name       = "listpal.dev.${var.domain_name}"
    validation_domain = var.root_domain_zone
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "acm_validation_cname" {
  for_each = {
    for dvo in aws_acm_certificate.login_cert.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 10
  type            = each.value.type
  zone_id         = data.aws_route53_zone.main.zone_id
}
