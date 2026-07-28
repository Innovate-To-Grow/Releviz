output "alb_dns_name" {
  value = aws_lb.app.dns_name
}

output "custom_domain" {
  value = var.custom_domain
}

output "origin_domain" {
  value = var.origin_domain
}

output "https_url" {
  value = "https://${var.custom_domain}"
}

output "amplify_app_id" {
  value = aws_amplify_app.frontend.id
}

output "amplify_default_domain" {
  value = aws_amplify_app.frontend.default_domain
}

output "amplify_candidate_branch_name" {
  value = aws_amplify_branch.candidate.branch_name
}

output "amplify_production_branch_name" {
  value = aws_amplify_branch.production.branch_name
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.app.name
}

output "backend_service_name" {
  value = aws_ecs_service.backend.name
}

output "frontend_service_name" {
  value = aws_ecs_service.frontend.name
}

output "backend_task_definition_arn" {
  value = aws_ecs_task_definition.backend.arn
}

output "frontend_task_definition_arn" {
  value = aws_ecs_task_definition.frontend.arn
}

output "database_master_secret_arn" {
  value = aws_db_instance.app.master_user_secret[0].secret_arn
}
