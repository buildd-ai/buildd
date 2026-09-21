CREATE TABLE "worker_terminal_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"worker_id" uuid NOT NULL,
	"task_id" uuid,
	"workspace_id" uuid,
	"outcome" text NOT NULL,
	"exit_cause" text,
	"turns" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(10, 6),
	"duration_ms" integer,
	"shipped" boolean DEFAULT false NOT NULL,
	"summary_provenance" text,
	"detail" jsonb
);
--> statement-breakpoint
ALTER TABLE "worker_terminal_records" ADD CONSTRAINT "worker_terminal_records_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_terminal_records" ADD CONSTRAINT "worker_terminal_records_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_terminal_records" ADD CONSTRAINT "worker_terminal_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "worker_terminal_records_worker_idx" ON "worker_terminal_records" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "worker_terminal_records_workspace_occurred_idx" ON "worker_terminal_records" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE INDEX "worker_terminal_records_outcome_occurred_idx" ON "worker_terminal_records" USING btree ("outcome","occurred_at");