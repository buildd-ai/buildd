DROP INDEX "tasks_active_planning_per_mission";--> statement-breakpoint
DROP INDEX "ws_skills_team_slug_idx";--> statement-breakpoint
DROP INDEX "ws_skills_workspace_slug_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_active_planning_per_mission" ON "tasks" USING btree ("mission_id") WHERE "tasks"."mode" = 'planning' AND "tasks"."status" IN ('pending', 'assigned', 'in_progress');--> statement-breakpoint
CREATE UNIQUE INDEX "ws_skills_team_slug_idx" ON "workspace_skills" USING btree ("team_id","slug") WHERE "workspace_skills"."workspace_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ws_skills_workspace_slug_idx" ON "workspace_skills" USING btree ("workspace_id","slug") WHERE "workspace_skills"."workspace_id" IS NOT NULL;