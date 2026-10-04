CREATE TABLE "orchestration_overlap_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"mission_id" uuid,
	"pair_key" text NOT NULL,
	"task_a_id" uuid NOT NULL,
	"task_b_id" uuid NOT NULL,
	"decision_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"answer" text NOT NULL,
	"confidence" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orchestration_manifest_predictions" ADD COLUMN "set_confidence" real;--> statement-breakpoint
ALTER TABLE "orchestration_manifest_predictions" ADD COLUMN "expected_size" jsonb;--> statement-breakpoint
ALTER TABLE "orchestration_overlap_answers" ADD CONSTRAINT "orchestration_overlap_answers_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orchestration_overlap_answers" ADD CONSTRAINT "orchestration_overlap_answers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orchestration_overlap_answers" ADD CONSTRAINT "orchestration_overlap_answers_task_a_id_tasks_id_fk" FOREIGN KEY ("task_a_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orchestration_overlap_answers" ADD CONSTRAINT "orchestration_overlap_answers_task_b_id_tasks_id_fk" FOREIGN KEY ("task_b_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "orchestration_overlap_answers_pair_decision_idx" ON "orchestration_overlap_answers" USING btree ("workspace_id","pair_key","decision_id");--> statement-breakpoint
CREATE INDEX "orchestration_overlap_answers_workspace_created_idx" ON "orchestration_overlap_answers" USING btree ("workspace_id","created_at");