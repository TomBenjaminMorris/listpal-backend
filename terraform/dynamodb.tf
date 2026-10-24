module "dynamodb_table" {
  source  = "terraform-aws-modules/dynamodb-table/aws"
  version = "4.0.0"

  name                        = "${var.app}-${var.env}"
  hash_key                    = "PK"
  range_key                   = "SK"
  table_class                 = "STANDARD"
  deletion_protection_enabled = false
  ttl_enabled                 = true
  ttl_attribute_name          = "ExpiryDateTTL"

  attributes = [
    {
      name = "GSI1-PK"
      type = "S"
    },
    {
      name = "GSI1-SK"
      type = "S"
    },
    {
      name = "PK"
      type = "S"
    },
    {
      name = "SK"
      type = "S"
    }
  ]

  global_secondary_indexes = [
    {
      name            = "GSI1"
      hash_key        = "GSI1-PK"
      range_key       = "GSI1-SK"
      projection_type = "ALL"
    }
  ]

  tags = local.tags
}
