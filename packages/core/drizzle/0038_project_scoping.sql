ALTER TABLE "tasks" ADD COLUMN "project" text;
--> statement-breakpoint
CREATE INDEX "tasks_project_idx" ON "tasks" ("project");
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "projects" jsonb DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE "observations" ADD COLUMN "project" text;
--> statement-breakpoint
CREATE INDEX "observations_project_idx" ON "observations" ("project");
