CREATE TABLE "task_area_prediction_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"experiment_id" text NOT NULL,
	"policy_version" text NOT NULL,
	"arm" text NOT NULL,
	"propensity" numeric(5, 4) NOT NULL,
	"fraction" numeric(5, 4) NOT NULL,
	"predicted_paths" jsonb NOT NULL,
	"predicted_path_source" text NOT NULL,
	"neighbour_task_ids" jsonb NOT NULL,
	"neighbours_considered" integer NOT NULL,
	"top_score" numeric(6, 5),
	"regex_paths" jsonb NOT NULL,
	"actual_paths" jsonb,
	"actual_recorded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_area_prediction_events" ADD CONSTRAINT "task_area_prediction_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_area_prediction_events" ADD CONSTRAINT "task_area_prediction_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_area_prediction_events_task_policy_idx" ON "task_area_prediction_events" USING btree ("task_id","policy_version");--> statement-breakpoint
CREATE INDEX "task_area_prediction_events_policy_arm_idx" ON "task_area_prediction_events" USING btree ("policy_version","arm");