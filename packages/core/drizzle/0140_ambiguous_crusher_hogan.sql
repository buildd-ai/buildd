CREATE TABLE "worker_action_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"task_id" uuid,
	"action" text NOT NULL,
	"ts" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "worker_action_events" ADD CONSTRAINT "worker_action_events_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_action_events" ADD CONSTRAINT "worker_action_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "worker_action_events_worker_ts_idx" ON "worker_action_events" USING btree ("worker_id","ts");--> statement-breakpoint
CREATE INDEX "worker_action_events_task_ts_idx" ON "worker_action_events" USING btree ("task_id","ts");--> statement-breakpoint
CREATE INDEX "worker_action_events_action_ts_idx" ON "worker_action_events" USING btree ("action","ts");