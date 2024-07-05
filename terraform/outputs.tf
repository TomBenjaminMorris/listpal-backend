output "api_endpoint" {
  description = "URI of the API, of the form `https://{api-id}.execute-api.{region}.amazonaws.com` for HTTP APIs and `wss://{api-id}.execute-api.{region}.amazonaws.com` for WebSocket APIs"
  value       = module.api_gateway.api_endpoint
}
