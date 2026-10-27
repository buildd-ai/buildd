ALTER TABLE "worker_heartbeats" ADD COLUMN "desired_paused" boolean;--> statement-breakpoint
ALTER TABLE "worker_heartbeats" ADD COLUMN "desired_pause_origin" text;--> statement-breakpoint
ALTER TABLE "worker_heartbeats" ADD COLUMN "desired_pause_set_by" text;--> statement-breakpoint
ALTER TABLE "worker_heartbeats" ADD COLUMN "desired_pause_set_at" timestamp with time zone;