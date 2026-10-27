CREATE TABLE "serial_lane_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"lane" text NOT NULL,
	"task_id" uuid NOT NULL,
	"claimable_since" timestamp with time zone,
	"joined_via" text DEFAULT 'manifest' NOT NULL,
	"held_at" timestamp with time zone,
	"activity_signature" text,
	"activity_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"left_reason" text,
	"released_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "serial_lane_entries_task_idx" ON "serial_lane_entries" ("workspace_id","lane","task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "serial_lane_entries_holder_idx" ON "serial_lane_entries" ("workspace_id","lane") WHERE "held_at" IS NOT NULL AND "left_at" IS NULL;--> statement-breakpoint
CREATE INDEX "serial_lane_entries_open_idx" ON "serial_lane_entries" ("workspace_id","lane") WHERE "left_at" IS NULL;--> statement-breakpoint
ALTER TABLE "serial_lane_entries" ADD CONSTRAINT "serial_lane_entries_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "serial_lane_entries" ADD CONSTRAINT "serial_lane_entries_task_id_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;