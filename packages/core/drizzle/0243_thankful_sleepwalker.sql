CREATE TABLE "deployment_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid,
	"task_id" uuid,
	"worker_id" uuid,
	"account_id" uuid,
	"principal" text NOT NULL,
	"role_slug" text,
	"operation" text NOT NULL,
	"capabilities" jsonb NOT NULL,
	"elevated" boolean DEFAULT false NOT NULL,
	"provider" text,
	"project" text,
	"environment" text,
	"credential_ref" text,
	"outcome" text NOT NULL,
	"reason" text,
	"result" jsonb
);
--> statement-breakpoint
ALTER TABLE "deployment_audit_events" ADD CONSTRAINT "deployment_audit_events_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_audit_events" ADD CONSTRAINT "deployment_audit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_audit_events" ADD CONSTRAINT "deployment_audit_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_audit_events" ADD CONSTRAINT "deployment_audit_events_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_audit_events" ADD CONSTRAINT "deployment_audit_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deployment_audit_events_workspace_occurred_idx" ON "deployment_audit_events" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE INDEX "deployment_audit_events_team_occurred_idx" ON "deployment_audit_events" USING btree ("team_id","occurred_at");--> statement-breakpoint
CREATE INDEX "deployment_audit_events_task_idx" ON "deployment_audit_events" USING btree ("task_id");