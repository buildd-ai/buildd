ALTER TABLE "knowledge_ingest_jobs" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "knowledge_ingest_jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_ingest_jobs" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_ingest_jobs" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "knowledge_ingest_jobs_lease_expires_at_idx" ON "knowledge_ingest_jobs" USING btree ("lease_expires_at");