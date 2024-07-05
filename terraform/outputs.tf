output "dynamodb_table_arn" {
  description = "ARN of the DynamoDB table"
  value       = module.dynamodb_table.dynamodb_table_arn
}

output "dynamodb_table_id" {
  description = "ID of the DynamoDB table"
  value       = module.dynamodb_table.dynamodb_table_id
}

output "api_endpoint" {
  description = "URI of the API, of the form `https://{api-id}.execute-api.{region}.amazonaws.com` for HTTP APIs and `wss://{api-id}.execute-api.{region}.amazonaws.com` for WebSocket APIs"
  value       = module.api_gateway.api_endpoint
}

output "api_arn" {
  description = "The ARN of the API"
  value       = module.api_gateway.api_arn
}

# output "routes" {
#   description = "Map of the routes created and their attributes"
#   value       = module.api_gateway.routes
# }
