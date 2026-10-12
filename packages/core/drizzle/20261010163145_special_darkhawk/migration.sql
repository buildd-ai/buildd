CREATE TABLE "platform_admin_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_account_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"team_id" uuid,
	"before" jsonb,
	"after" jsonb
);
--> statement-breakpoint
ALTER TABLE "platform_admin_audit_events" ADD CONSTRAINT "platform_admin_audit_events_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_admin_audit_events_target_occurred_idx" ON "platform_admin_audit_events" USING btree ("target_type","target_id","occurred_at");