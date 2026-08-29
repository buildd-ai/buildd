ALTER TABLE "releases" ADD COLUMN "ci_state_at_dispatch" text;--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "commits_ahead_at_dispatch" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "releases_workspace_sha_idx" ON "releases" USING btree ("workspace_id","head_sha");