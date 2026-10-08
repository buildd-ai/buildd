CREATE TABLE "initiatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"progress_cache" jsonb,
	"context_artifact_ids" jsonb DEFAULT '[]'::jsonb,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "initiative_id" uuid;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "initiative_id" uuid;--> statement-breakpoint
ALTER TABLE "initiatives" ADD CONSTRAINT "initiatives_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "initiatives" ADD CONSTRAINT "initiatives_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "initiatives" ADD CONSTRAINT "initiatives_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "initiatives_team_idx" ON "initiatives" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "initiatives_workspace_idx" ON "initiatives" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "initiatives_status_idx" ON "initiatives" USING btree ("status");--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_initiative_id_initiatives_id_fk" FOREIGN KEY ("initiative_id") REFERENCES "public"."initiatives"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_initiative_id_initiatives_id_fk" FOREIGN KEY ("initiative_id") REFERENCES "public"."initiatives"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_initiative_idx" ON "artifacts" USING btree ("initiative_id");--> statement-breakpoint
CREATE INDEX "missions_initiative_idx" ON "missions" USING btree ("initiative_id");