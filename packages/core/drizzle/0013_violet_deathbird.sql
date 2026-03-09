ALTER TABLE "objectives" ADD COLUMN "is_heartbeat" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "objectives" ADD COLUMN "heartbeat_checklist" text;--> statement-breakpoint
ALTER TABLE "objectives" ADD COLUMN "active_hours_start" integer;--> statement-breakpoint
ALTER TABLE "objectives" ADD COLUMN "active_hours_end" integer;--> statement-breakpoint
ALTER TABLE "objectives" ADD COLUMN "active_hours_timezone" text;