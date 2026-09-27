ALTER TABLE "teams" ADD COLUMN "inference_feature_modes" jsonb;--> statement-breakpoint
-- Chat is on whenever a key resolves. 0188 switched chat OFF for teams that
-- already held a key, which left them an "enable" step that should not exist.
-- Undo it for every team nobody has edited since 0188 was generated: the column
-- did not exist before then, so no admin can have switched chat off on such a
-- team. A team edited since keeps its value, since that edit may have been an
-- admin switching chat off.
UPDATE "teams" t SET "chat_disabled" = false
WHERE t."chat_disabled" = true
  AND t."updated_at" < to_timestamp(1790464318.880)
  AND EXISTS (
    SELECT 1 FROM "secrets" s
    WHERE s."team_id" = t."id" AND s."purpose" IN ('inference_key', 'anthropic_api_key', 'decision_key')
  );
