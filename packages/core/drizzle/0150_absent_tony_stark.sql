CREATE TABLE "review_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid,
	"worker_id" uuid,
	"repo_full_name" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text,
	"kind" text NOT NULL,
	"state" text,
	"path" text,
	"line" integer,
	"diff_hunk" text,
	"body" text NOT NULL,
	"author_login" text,
	"author_type" text NOT NULL,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "review_feedback_github_id_unique" ON "review_feedback" USING btree ("github_id");--> statement-breakpoint
CREATE INDEX "review_feedback_workspace_path_idx" ON "review_feedback" USING btree ("workspace_id","path");--> statement-breakpoint
CREATE INDEX "review_feedback_pr_idx" ON "review_feedback" USING btree ("workspace_id","pr_number");--> statement-breakpoint
CREATE INDEX "review_feedback_task_idx" ON "review_feedback" USING btree ("task_id");