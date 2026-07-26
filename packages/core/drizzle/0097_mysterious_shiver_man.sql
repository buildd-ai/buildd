CREATE TABLE "task_subject_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key_type" text NOT NULL,
	"key_hash" text NOT NULL,
	"canonical_task_id" uuid NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "task_subject_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"reporting_task_id" uuid,
	"origin" text NOT NULL,
	"reporter_id" uuid,
	"note" text,
	"anchor_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "subject_anchor" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "subject_kind" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "subject_pr_number" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "subject_head_sha" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "subject_branch" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "subject_error_signature" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "subject_mission_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "subject_dedupe_scope" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "subject_superseded_by_task_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "subject_resolution" text;--> statement-breakpoint
ALTER TABLE "task_subject_claims" ADD CONSTRAINT "task_subject_claims_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_subject_claims" ADD CONSTRAINT "task_subject_claims_canonical_task_id_tasks_id_fk" FOREIGN KEY ("canonical_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_subject_reports" ADD CONSTRAINT "task_subject_reports_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_subject_reports" ADD CONSTRAINT "task_subject_reports_reporter_id_accounts_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_subject_claims_workspace_idx" ON "task_subject_claims" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "task_subject_claims_canonical_task_idx" ON "task_subject_claims" USING btree ("canonical_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_subject_claims_active_unique" ON "task_subject_claims" USING btree ("workspace_id","key_type","key_hash") WHERE "task_subject_claims"."state" = 'active';--> statement-breakpoint
CREATE INDEX "task_subject_reports_task_idx" ON "task_subject_reports" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_subject_reports_reporting_task_idx" ON "task_subject_reports" USING btree ("reporting_task_id");--> statement-breakpoint
CREATE INDEX "task_subject_reports_created_at_idx" ON "task_subject_reports" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "tasks_subject_kind_idx" ON "tasks" USING btree ("workspace_id","subject_kind");--> statement-breakpoint
CREATE INDEX "tasks_subject_pr_idx" ON "tasks" USING btree ("workspace_id","subject_pr_number");--> statement-breakpoint
CREATE INDEX "tasks_subject_head_sha_idx" ON "tasks" USING btree ("workspace_id","subject_head_sha");--> statement-breakpoint
CREATE INDEX "tasks_subject_error_idx" ON "tasks" USING btree ("workspace_id","subject_error_signature");--> statement-breakpoint
CREATE INDEX "tasks_subject_mission_idx" ON "tasks" USING btree ("workspace_id","subject_mission_id");--> statement-breakpoint
CREATE INDEX "tasks_subject_dedupe_scope_idx" ON "tasks" USING btree ("workspace_id","subject_dedupe_scope");