CREATE TABLE "root_causes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"team_id" uuid NOT NULL,
	"key" text NOT NULL,
	"capability_kind" text NOT NULL,
	"runner_id" uuid,
	"provider" text,
	"component" text,
	"workspace_id" uuid,
	"classification" text NOT NULL,
	"affected_task_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"verified_restored_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "root_causes_team_key_idx" ON "root_causes" ("team_id","key");--> statement-breakpoint
CREATE INDEX "root_causes_runner_idx" ON "root_causes" ("runner_id");--> statement-breakpoint
CREATE INDEX "root_causes_last_seen_idx" ON "root_causes" ("last_seen_at");--> statement-breakpoint
ALTER TABLE "root_causes" ADD CONSTRAINT "root_causes_team_id_teams_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "root_causes" ADD CONSTRAINT "root_causes_runner_id_accounts_id_fkey" FOREIGN KEY ("runner_id") REFERENCES "accounts"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "root_causes" ADD CONSTRAINT "root_causes_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;