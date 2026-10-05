CREATE TABLE "agent_capability_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid,
	"task_id" uuid,
	"worker_id" uuid,
	"account_id" uuid,
	"principal_via" text,
	"capability" text NOT NULL,
	"resource" text,
	"decision" text NOT NULL,
	"reason_code" text,
	"expires_at" timestamp with time zone,
	"side_effect" jsonb
);
--> statement-breakpoint
ALTER TABLE "agent_capability_decisions" ADD CONSTRAINT "agent_capability_decisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_capability_decisions" ADD CONSTRAINT "agent_capability_decisions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_capability_decisions" ADD CONSTRAINT "agent_capability_decisions_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_capability_decisions" ADD CONSTRAINT "agent_capability_decisions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_capability_decisions_worker_occurred_idx" ON "agent_capability_decisions" USING btree ("worker_id","occurred_at");--> statement-breakpoint
CREATE INDEX "agent_capability_decisions_workspace_occurred_idx" ON "agent_capability_decisions" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE INDEX "agent_capability_decisions_occurred_idx" ON "agent_capability_decisions" USING btree ("occurred_at");