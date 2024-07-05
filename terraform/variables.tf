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