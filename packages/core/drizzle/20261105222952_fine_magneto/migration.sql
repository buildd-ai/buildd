CREATE TABLE "voyage_usage_daily" (
	"day" date,
	"team_id" uuid,
	"kind" text,
	"model" text,
	"corpus" text,
	"caller" text,
	"key_source" text,
	"tokens" bigint DEFAULT 0 NOT NULL,
	"calls" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "voyage_usage_daily_pkey" PRIMARY KEY("day","team_id","kind","model","corpus","caller","key_source")
);
--> statement-breakpoint
CREATE TABLE "voyage_usage_monthly" (
	"team_id" uuid,
	"month" text,
	"kind" text,
	"tokens" bigint DEFAULT 0 NOT NULL,
	"calls" bigint DEFAULT 0 NOT NULL,
	"denied_calls" bigint DEFAULT 0 NOT NULL,
	"exhausted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voyage_usage_monthly_pkey" PRIMARY KEY("team_id","month","kind")
);
--> statement-breakpoint
ALTER TABLE "voyage_usage_daily" ADD CONSTRAINT "voyage_usage_daily_team_id_teams_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "voyage_usage_monthly" ADD CONSTRAINT "voyage_usage_monthly_team_id_teams_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;