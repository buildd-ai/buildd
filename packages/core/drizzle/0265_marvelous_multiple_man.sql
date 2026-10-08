CREATE TABLE "task_pull_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"worker_id" uuid,
	"pr_url" text NOT NULL,
	"pr_number" integer,
	"state" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_pull_requests" ADD CONSTRAINT "task_pull_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_pull_requests" ADD CONSTRAINT "task_pull_requests_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_pull_requests_task_url_idx" ON "task_pull_requests" USING btree ("task_id","pr_url");--> statement-breakpoint
CREATE INDEX "task_pull_requests_pr_url_idx" ON "task_pull_requests" USING btree ("pr_url");