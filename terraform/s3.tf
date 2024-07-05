resource "random_pet" "lambda_bucket_name" {
  prefix = "${lower(var.app)}-${lower(var.env)}-api"
  length = 1
}

data "archive_file" "api_lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../src"
  output_path = "${path.module}/../src.zip"
}

# resource "aws_s3_object" "api_object" {
#   bucket = module.s3_bucket.s3_bucket_id
#   key    = "src.zip"
#   source = data.archive_file.api_lambda.output_path
#   etag   = filemd5(data.archive_file.api_lambda.output_path)
# }

# module "s3_bucket" {
#   source  = "terraform-aws-modules/s3-bucket/aws"
#   version = "4.1.2"

#   bucket_prefix = random_pet.lambda_bucket_name.id
#   force_destroy = true

#   # S3 bucket-level Public Access Block configuration
#   block_public_acls       = true
#   block_public_policy     = true
#   ignore_public_acls      = true
#   restrict_public_buckets = true
# }