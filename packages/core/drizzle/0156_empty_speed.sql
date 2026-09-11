CREATE TABLE "spec_discrepancies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"spec_path" text NOT NULL,
	"assertion_id" text NOT NULL,
	"direction" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_reason" text,
	"promoted_mission_id" uuid,
	"evidence" jsonb
);
--> statement-breakpoint
ALTER TABLE "spec_discrepancies" ADD CONSTRAINT "spec_discrepancies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_discrepancies" ADD CONSTRAINT "spec_discrepancies_promoted_mission_id_missions_id_fk" FOREIGN KEY ("promoted_mission_id") REFERENCES "public"."missions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spec_discrepancies_workspace_idx" ON "spec_discrepancies" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "spec_discrepancies_identity_unique" ON "spec_discrepancies" USING btree ("workspace_id","spec_path","assertion_id");