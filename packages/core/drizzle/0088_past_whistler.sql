CREATE TABLE "migration_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_team_id" uuid NOT NULL,
	"destination_team_id" uuid NOT NULL,
	"phase" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"detail" jsonb DEFAULT '{}'::jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "migration_log" ADD CONSTRAINT "migration_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_log" ADD CONSTRAINT "migration_log_source_team_id_teams_id_fk" FOREIGN KEY ("source_team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_log" ADD CONSTRAINT "migration_log_destination_team_id_teams_id_fk" FOREIGN KEY ("destination_team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "migration_log_run_idx" ON "migration_log" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "migration_log_workspace_idx" ON "migration_log" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "migration_log_run_phase_idx" ON "migration_log" USING btree ("run_id","phase");