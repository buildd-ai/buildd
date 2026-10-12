CREATE TABLE "dependency_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dependent_task_id" uuid NOT NULL,
	"upstream_task_id" uuid NOT NULL,
	"upstream_pr_number" integer NOT NULL,
	"decision" text NOT NULL,
	"source" text NOT NULL,
	"reason_code" text NOT NULL,
	"base_branch" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text
);
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "branch_refresh_head_sha" text;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "branch_refresh_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "branch_refresh_lease_token" text;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "branch_refresh_conflict_task_id" uuid;--> statement-breakpoint
ALTER TABLE "dependency_releases" ADD CONSTRAINT "dependency_releases_dependent_task_id_tasks_id_fk" FOREIGN KEY ("dependent_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency_releases" ADD CONSTRAINT "dependency_releases_upstream_task_id_tasks_id_fk" FOREIGN KEY ("upstream_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dependency_releases_dependent_upstream_idx" ON "dependency_releases" USING btree ("dependent_task_id","upstream_task_id");