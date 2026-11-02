ALTER TABLE "worker_heartbeats" ADD COLUMN "presence_connected" boolean;--> statement-breakpoint
ALTER TABLE "worker_heartbeats" ADD COLUMN "presence_changed_at" timestamp with time zone;