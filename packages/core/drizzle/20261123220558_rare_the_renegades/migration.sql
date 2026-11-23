ALTER TABLE "skill_usage" DROP CONSTRAINT "skill_usage_skill_id_workspace_skills_id_fkey";--> statement-breakpoint
ALTER TABLE "skill_usage" ADD COLUMN "telemetry_started_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "skill_usage" u SET "telemetry_started_at" = t.started
FROM (SELECT "team_id", min("first_claimed_at") AS started FROM "skill_usage" GROUP BY "team_id") t
WHERE u."team_id" = t."team_id";
