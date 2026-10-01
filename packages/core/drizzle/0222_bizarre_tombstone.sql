ALTER TABLE "tasks" ADD COLUMN "path_declaration" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "path_claim_revision" integer DEFAULT 0 NOT NULL;