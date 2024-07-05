terraform {
  backend "s3" {
    bucket = "tbm-tf-state-bucket"
    key    = "listpal-infra"
    region = "eu-west-1"
  }

  required_version = ">= 1.3"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.21"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 2.0"
    }
    local = {
      source  = "hashicorp/local"
      version = ">= 2.5"
    }
    null = {
      source  = "hashicorp/null"
      version = ">= 2.0"
    }
  }
}