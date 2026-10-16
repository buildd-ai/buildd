CREATE TABLE "decision_model_switches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"team_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"cause" text NOT NULL,
	"from_route" jsonb,
	"to_route" jsonb,
	"eval_run_id" text,
	"before_score" real,
	"after_score" real,
	"bar" real,
	"n" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"pinned_until" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "decision_model_optimizer" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "decision_model_switches_team_kind_idx" ON "decision_model_switches" ("team_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "decision_model_switches_status_idx" ON "decision_model_switches" ("status","created_at");--> statement-breakpoint
ALTER TABLE "decision_model_switches" ADD CONSTRAINT "decision_model_switches_team_id_teams_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;