CREATE TABLE "release_tasks" (
	"release_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"pr_number" integer,
	"commit_sha" text,
	CONSTRAINT "release_tasks_release_id_task_id_pk" PRIMARY KEY("release_id","task_id")
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"archetype" text NOT NULL,
	"unit" text,
	"strategy" text,
	"source_ref" text,
	"target_ref" text,
	"head_sha" text,
	"previous_sha" text,
	"version" text,
	"state" text DEFAULT 'deploying' NOT NULL,
	"verification_strategy" text DEFAULT 'none' NOT NULL,
	"dispatched_at" timestamp with time zone,
	"deployed_at" timestamp with time zone,
	"healthy_at" timestamp with time zone,
	"run_url" text,
	"deploy_url" text,
	"triggered_by" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "release_tasks" ADD CONSTRAINT "release_tasks_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_tasks" ADD CONSTRAINT "release_tasks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "releases_workspace_idx" ON "releases" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "releases_state_idx" ON "releases" USING btree ("state");