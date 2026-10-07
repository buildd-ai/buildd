ALTER TABLE "missions" ADD COLUMN "branch_refresh_head_sha" text;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "branch_refresh_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "branch_refresh_lease_token" text;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "branch_refresh_conflict_task_id" uuid;