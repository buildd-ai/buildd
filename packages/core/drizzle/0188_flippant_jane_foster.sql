ALTER TABLE "teams" ADD COLUMN "inference_key_policy" text DEFAULT 'team' NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "chat_disabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Personal chat keys shipped before this policy existed and always won over the
-- team key. A team where anyone already set one keeps that behaviour.
UPDATE "teams" t SET "inference_key_policy" = 'team_or_own'
WHERE EXISTS (
  SELECT 1 FROM "secrets" s
  WHERE s."team_id" = t."id" AND s."purpose" = 'inference_key' AND s."user_id" IS NOT NULL
);--> statement-breakpoint
-- Chat now turns on by itself once a key resolves. A team that already holds a
-- key chat could spend, and never turned chat on, stays off until an admin
-- turns it on: no existing team starts spending without having acted.
UPDATE "teams" t SET "chat_disabled" = true
WHERE NOT ('chat' = ANY(COALESCE(t."enabled_inference_capabilities", ARRAY[]::text[])))
  AND EXISTS (
    SELECT 1 FROM "secrets" s
    WHERE s."team_id" = t."id" AND s."purpose" IN ('inference_key', 'anthropic_api_key', 'decision_key')
  );
