ALTER TABLE "missions" ADD COLUMN "integration_branch_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "pr_base_ref" text;