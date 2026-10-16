CREATE TABLE "runner_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid,
	"worker_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"size" text NOT NULL,
	"runner_seconds" integer NOT NULL,
	"weighted_runner_seconds" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "hosted_runner_hours" integer;--> statement-breakpoint
ALTER TABLE "runner_usage" ADD CONSTRAINT "runner_usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_usage" ADD CONSTRAINT "runner_usage_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_usage" ADD CONSTRAINT "runner_usage_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runner_usage_worker_attempt_idx" ON "runner_usage" USING btree ("worker_id","attempt");--> statement-breakpoint
CREATE INDEX "runner_usage_workspace_ended_idx" ON "runner_usage" USING btree ("workspace_id","ended_at");--> statement-breakpoint
CREATE INDEX "runner_usage_task_idx" ON "runner_usage" USING btree ("task_id");