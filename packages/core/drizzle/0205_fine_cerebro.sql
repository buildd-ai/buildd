CREATE TABLE "visual_shot_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"audit_task_id" uuid,
	"round" integer NOT NULL,
	"cell_key" text NOT NULL,
	"route" text NOT NULL,
	"viewport" text NOT NULL,
	"agent_verdict" text NOT NULL,
	"decision" text NOT NULL,
	"relation" text NOT NULL,
	"note" text,
	"fix_task_id" uuid,
	"cancelled_fix_task_id" uuid,
	"reviewer_user_id" uuid,
	"reviewer_label" text,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "visual_shot_reviews" ADD CONSTRAINT "visual_shot_reviews_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visual_shot_reviews" ADD CONSTRAINT "visual_shot_reviews_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visual_shot_reviews" ADD CONSTRAINT "visual_shot_reviews_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visual_shot_reviews" ADD CONSTRAINT "visual_shot_reviews_audit_task_id_tasks_id_fk" FOREIGN KEY ("audit_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visual_shot_reviews" ADD CONSTRAINT "visual_shot_reviews_fix_task_id_tasks_id_fk" FOREIGN KEY ("fix_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visual_shot_reviews" ADD CONSTRAINT "visual_shot_reviews_cancelled_fix_task_id_tasks_id_fk" FOREIGN KEY ("cancelled_fix_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visual_shot_reviews" ADD CONSTRAINT "visual_shot_reviews_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "visual_shot_reviews_mission_idx" ON "visual_shot_reviews" USING btree ("mission_id","superseded_at");--> statement-breakpoint
CREATE INDEX "visual_shot_reviews_artifact_idx" ON "visual_shot_reviews" USING btree ("artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "visual_shot_reviews_one_active_per_artifact" ON "visual_shot_reviews" USING btree ("artifact_id") WHERE superseded_at IS NULL;