CREATE TABLE "schedule_moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"schedule_id" uuid NOT NULL,
	"from_workspace_id" uuid NOT NULL,
	"to_workspace_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"evidence" jsonb,
	"proposed_by_task_id" uuid,
	"decided_by_user_id" uuid,
	"decided_by_account_id" uuid,
	"decided_at" timestamp with time zone,
	"granted_old_home" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_refusals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"schedule_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "schedule_moves_schedule_idx" ON "schedule_moves" ("schedule_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_moves_open_per_schedule_idx" ON "schedule_moves" ("schedule_id") WHERE status = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_refusals_unique_idx" ON "schedule_refusals" ("schedule_id","workspace_id","task_id");--> statement-breakpoint
ALTER TABLE "schedule_moves" ADD CONSTRAINT "schedule_moves_schedule_id_task_schedules_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "task_schedules"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "schedule_moves" ADD CONSTRAINT "schedule_moves_from_workspace_id_workspaces_id_fkey" FOREIGN KEY ("from_workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "schedule_moves" ADD CONSTRAINT "schedule_moves_to_workspace_id_workspaces_id_fkey" FOREIGN KEY ("to_workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "schedule_moves" ADD CONSTRAINT "schedule_moves_decided_by_user_id_users_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "schedule_moves" ADD CONSTRAINT "schedule_moves_decided_by_account_id_accounts_id_fkey" FOREIGN KEY ("decided_by_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "schedule_refusals" ADD CONSTRAINT "schedule_refusals_schedule_id_task_schedules_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "task_schedules"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "schedule_refusals" ADD CONSTRAINT "schedule_refusals_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;