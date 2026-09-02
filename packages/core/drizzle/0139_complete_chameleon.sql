ALTER TABLE "mission_notes" ADD COLUMN "actor_label" text;--> statement-breakpoint
ALTER TABLE "mission_notes" ADD COLUMN "collapse_key" text;--> statement-breakpoint
ALTER TABLE "mission_notes" ADD COLUMN "collapse_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "mission_notes_collapse_key_idx" ON "mission_notes" USING btree ("mission_id","collapse_key","created_at");