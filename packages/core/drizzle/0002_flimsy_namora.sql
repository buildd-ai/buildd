ALTER TABLE "tasks" DROP CONSTRAINT "tasks_source_id_sources_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_skills" DROP CONSTRAINT "workspace_skills_skill_id_skills_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "tasks_source_external_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "workspace_skills_skill_idx";--> statement-breakpoint
DROP TABLE "skills";--> statement-breakpoint
DROP TABLE "sources";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "source_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "blocked_by_task_ids";--> statement-breakpoint
ALTER TABLE "workspace_skills" DROP COLUMN IF EXISTS "skill_id";