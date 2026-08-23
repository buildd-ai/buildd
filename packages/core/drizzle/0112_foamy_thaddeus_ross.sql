ALTER TABLE "worker_heartbeats" ADD COLUMN "sandbox_enabled" boolean;--> statement-breakpoint
ALTER TABLE "worker_heartbeats" ADD COLUMN "sandbox_probe_at" timestamp with time zone;