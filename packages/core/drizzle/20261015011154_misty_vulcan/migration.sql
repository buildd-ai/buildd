CREATE TABLE "workflow_mission_epochs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"mission_id" uuid NOT NULL,
	"epoch" integer NOT NULL,
	"branch" text NOT NULL,
	"state" text NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"origin" text NOT NULL,
	"cut_from_sha" text,
	"branch_ready_at" timestamp with time zone,
	"predecessor_id" uuid,
	"scope_version" integer DEFAULT 1 NOT NULL,
	"repo_full_name" text,
	"pr_number" integer,
	"owner_task_id" uuid,
	"merged_at" timestamp with time zone,
	"merge_commit_sha" text,
	"merged_head_sha" text,
	"settlement" jsonb,
	"settled_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_mission_epochs_epoch_unique" ON "workflow_mission_epochs" ("mission_id","epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_mission_epochs_successor_unique" ON "workflow_mission_epochs" ("predecessor_id") WHERE "predecessor_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_mission_epochs_open_unique" ON "workflow_mission_epochs" ("mission_id") WHERE "state" = 'open';--> statement-breakpoint
ALTER TABLE "workflow_mission_epochs" ADD CONSTRAINT "workflow_mission_epochs_mission_id_missions_id_fkey" FOREIGN KEY ("mission_id") REFERENCES "missions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_mission_epochs" ADD CONSTRAINT "workflow_mission_epochs_owner_task_id_tasks_id_fkey" FOREIGN KEY ("owner_task_id") REFERENCES "tasks"("id") ON DELETE SET NULL;