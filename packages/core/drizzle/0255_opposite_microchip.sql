ALTER TABLE "quality_scout_findings" ADD COLUMN "dismissed_reason" text;--> statement-breakpoint
ALTER TABLE "quality_scout_findings" ADD COLUMN "dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quality_scout_findings" ADD COLUMN "dismissed_by" text;