variable "env" {
  type        = string
  description = "The environment the project is being deployed to"
  default     = "Dev"
}

variable "app" {
  type        = string
  description = "The name of the app"
  default     = "ListPal"
}

variable "domain_name" {
  type        = string
  description = "The root domain name of the api"
  default     = "vinsp.in"
}

variable "root_domain_zone" {
  type        = string
  description = "The root domain name for the website."
  default     = "vinsp.in"
}

variable "openai_api_key" {
  type      = string
  default   = "example-key"
  sensitive = true
}
