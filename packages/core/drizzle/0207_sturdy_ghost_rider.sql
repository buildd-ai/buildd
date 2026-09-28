ALTER TABLE "memories" ADD COLUMN "state" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "source_kind" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "external" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "valid_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "invalidated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "reverify_flagged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "reverify_ref" text;--> statement-breakpoint
CREATE INDEX "memories_state_created_idx" ON "memories" USING btree ("state","created_at");