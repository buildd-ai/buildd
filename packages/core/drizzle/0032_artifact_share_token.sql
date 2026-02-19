ALTER TABLE "artifacts" ADD COLUMN "share_token" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "artifacts_share_token_idx" ON "artifacts" ("share_token");
