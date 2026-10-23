ALTER TABLE "worker_heartbeats" ADD COLUMN "desired_slots" integer;--> statement-breakpoint
ALTER TABLE "worker_heartbeats" ADD COLUMN "desired_slots_origin" text;--> statement-breakpoint
ALTER TABLE "worker_heartbeats" ADD COLUMN "desired_slots_set_by" text;--> statement-breakpoint
ALTER TABLE "worker_heartbeats" ADD COLUMN "desired_slots_set_at" timestamp with time zone;