ALTER TABLE "spec_revisions" ADD COLUMN "imported" jsonb;--> statement-breakpoint
ALTER TABLE "specs" ADD COLUMN "repo_source" jsonb;--> statement-breakpoint
CREATE INDEX "specs_repo_source_path_idx" ON "specs" ("workspace_id",("repo_source"->>'path'));