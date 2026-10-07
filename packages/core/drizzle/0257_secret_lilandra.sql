ALTER TABLE "quality_scout_probes" ADD COLUMN "host" text;--> statement-breakpoint
ALTER TABLE "quality_scout_runs" ADD COLUMN "host_state" jsonb;--> statement-breakpoint
ALTER TABLE "quality_scout_runs" ADD COLUMN "host_deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quality_scout_runs" ADD COLUMN "host_lease_holder" text;--> statement-breakpoint
ALTER TABLE "quality_scout_runs" ADD COLUMN "host_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quality_scout_runs" ADD COLUMN "host_lease_lapses" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "quality_scout_runs_status_host_deadline_idx" ON "quality_scout_runs" USING btree ("status","host_deadline");