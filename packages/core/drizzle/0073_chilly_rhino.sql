ALTER TABLE "knowledge_chunks" ADD COLUMN "hit_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN "last_hit_at" timestamp with time zone;