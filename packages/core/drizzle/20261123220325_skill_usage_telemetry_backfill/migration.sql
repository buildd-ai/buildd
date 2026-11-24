UPDATE "skill_usage" u SET "telemetry_started_at" = t.started
FROM (SELECT "team_id", min("first_claimed_at") AS started FROM "skill_usage" GROUP BY "team_id") t
WHERE u."team_id" = t."team_id";
