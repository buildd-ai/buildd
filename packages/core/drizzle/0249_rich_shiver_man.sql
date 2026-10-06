ALTER TABLE "accounts" ADD COLUMN "managed_runner" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "managed_runner_plan" jsonb;