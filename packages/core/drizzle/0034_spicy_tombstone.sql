ALTER TABLE "missions" ADD COLUMN "working_branch" text;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "primary_pr_number" integer;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "primary_pr_url" text;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "last_notified_sha" text;