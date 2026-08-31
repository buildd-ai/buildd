ALTER TABLE "missions" ADD COLUMN "criteria_rearm_fingerprint" text;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "criteria_rearm_cycles" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "criteria_rearmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "criteria_escalated_at" timestamp with time zone;