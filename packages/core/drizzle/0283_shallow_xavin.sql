ALTER TABLE "oauth_refresh_tokens" ADD COLUMN "family_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN "family_issued_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_family_idx" ON "oauth_refresh_tokens" USING btree ("family_id");
--> statement-breakpoint
-- Refresh tokens are stored as the SHA-256 (lowercase hex) of the token, and
-- looked up by that hash (apps/web/src/lib/oauth/storage.ts hashes the same
-- way). Existing rows are hashed in place so every live session keeps
-- refreshing. sha256() is built into Postgres 11+, so no extension is needed.
-- Idempotent: an issued token is 43 base64url characters and can never look
-- like a 64-character hex digest, so a row already hashed is left alone.
UPDATE "oauth_refresh_tokens"
SET "token" = encode(sha256(convert_to("token", 'UTF8')), 'hex')
WHERE "token" !~ '^[0-9a-f]{64}$';--> statement-breakpoint
-- A row that predates families gets its own family (the column default above)
-- whose sign-in time is the row's own issue time, the earliest time on record
-- for it. The ADD COLUMN default stamped such rows with the migration time,
-- which is later than created_at; a row issued since always has
-- family_issued_at <= created_at, so it is never touched. Idempotent.
UPDATE "oauth_refresh_tokens"
SET "family_issued_at" = "created_at"
WHERE "family_issued_at" > "created_at";
