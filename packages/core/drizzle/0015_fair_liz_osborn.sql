ALTER TABLE "workers" ADD COLUMN "runner" text DEFAULT 'api' NOT NULL;
--> statement-breakpoint
-- Backfill existing workers: default to 'api' (already set by DEFAULT above)
-- Remove the default so future inserts must provide runner explicitly
ALTER TABLE "workers" ALTER COLUMN "runner" DROP DEFAULT;
