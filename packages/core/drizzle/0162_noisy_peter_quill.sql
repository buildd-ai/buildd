CREATE TABLE "gate_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"gate" text NOT NULL,
	"surface" text NOT NULL,
	"workspace_id" uuid,
	"mission_id" uuid,
	"task_id" uuid,
	"worker_id" uuid,
	"outcome" text NOT NULL,
	"reason" text NOT NULL,
	"detail" jsonb,
	"caller_origin" text
);
--> statement-breakpoint
ALTER TABLE "gate_events" ADD CONSTRAINT "gate_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_events" ADD CONSTRAINT "gate_events_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_events" ADD CONSTRAINT "gate_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_events" ADD CONSTRAINT "gate_events_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gate_events_workspace_occurred_idx" ON "gate_events" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE INDEX "gate_events_gate_occurred_idx" ON "gate_events" USING btree ("gate","occurred_at");--> statement-breakpoint
CREATE INDEX "gate_events_task_idx" ON "gate_events" USING btree ("task_id");