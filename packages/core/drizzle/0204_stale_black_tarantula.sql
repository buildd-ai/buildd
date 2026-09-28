ALTER TABLE "memories" ADD COLUMN "superseded_by" uuid;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "index_failures" integer DEFAULT 0 NOT NULL;