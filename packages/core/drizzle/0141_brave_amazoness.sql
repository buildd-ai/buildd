ALTER TABLE "workers" ADD COLUMN "pr_check_failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "pr_unresolvable_reason" text;