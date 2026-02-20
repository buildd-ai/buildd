ALTER TABLE "artifacts" ADD COLUMN "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "key" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_workspace_idx" ON "artifacts" ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "artifacts_workspace_key_idx" ON "artifacts" ("workspace_id", "key");
