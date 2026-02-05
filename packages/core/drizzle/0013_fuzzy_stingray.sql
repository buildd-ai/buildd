ALTER TABLE "accounts" ADD COLUMN "api_key_prefix" text;--> statement-breakpoint
UPDATE "accounts" SET "api_key_prefix" = LEFT("api_key", 12), "api_key" = encode(sha256("api_key"::bytea), 'hex') WHERE "api_key" LIKE 'bld_%';
