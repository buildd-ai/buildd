CREATE TABLE "mcp_oauth_grant_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"grant_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_grant_teams" (
	"grant_id" uuid,
	"team_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_grant_teams_pkey" PRIMARY KEY("grant_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "mcp_oauth_grant_events_grant_occurred_idx" ON "mcp_oauth_grant_events" ("grant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "mcp_oauth_grant_teams_team_idx" ON "mcp_oauth_grant_teams" ("team_id");--> statement-breakpoint
ALTER TABLE "mcp_oauth_grant_events" ADD CONSTRAINT "mcp_oauth_grant_events_grant_id_mcp_oauth_grants_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "mcp_oauth_grants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mcp_oauth_grant_events" ADD CONSTRAINT "mcp_oauth_grant_events_actor_user_id_users_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "mcp_oauth_grant_teams" ADD CONSTRAINT "mcp_oauth_grant_teams_grant_id_mcp_oauth_grants_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "mcp_oauth_grants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mcp_oauth_grant_teams" ADD CONSTRAINT "mcp_oauth_grant_teams_team_id_teams_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;