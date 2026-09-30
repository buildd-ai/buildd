CREATE TABLE "evidence_backends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid,
	"provider" text NOT NULL,
	"endpoint" text,
	"region" text,
	"bucket" text NOT NULL,
	"prefix" text,
	"force_path_style" boolean DEFAULT false NOT NULL,
	"credential_secret_id" uuid,
	"sse" text DEFAULT 'none' NOT NULL,
	"kms_key_id" text,
	"retention_days" integer DEFAULT 30 NOT NULL,
	"max_bytes_per_task" integer DEFAULT 8388608 NOT NULL,
	"status" text DEFAULT 'unverified' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"root_task_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"pr_number" integer,
	"kind" text NOT NULL,
	"backend_id" uuid,
	"object_key" text NOT NULL,
	"bytes" bigint NOT NULL,
	"sha256" text,
	"upload_state" text DEFAULT 'pending' NOT NULL,
	"index_state" text DEFAULT 'skipped' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evidence_backends" ADD CONSTRAINT "evidence_backends_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_backends" ADD CONSTRAINT "evidence_backends_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_backends" ADD CONSTRAINT "evidence_backends_credential_secret_id_secrets_id_fk" FOREIGN KEY ("credential_secret_id") REFERENCES "public"."secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_objects" ADD CONSTRAINT "evidence_objects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_objects" ADD CONSTRAINT "evidence_objects_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_objects" ADD CONSTRAINT "evidence_objects_root_task_id_tasks_id_fk" FOREIGN KEY ("root_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_objects" ADD CONSTRAINT "evidence_objects_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_objects" ADD CONSTRAINT "evidence_objects_backend_id_evidence_backends_id_fk" FOREIGN KEY ("backend_id") REFERENCES "public"."evidence_backends"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_backends_team_idx" ON "evidence_backends" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "evidence_backends_workspace_team_idx" ON "evidence_backends" USING btree ("workspace_id","team_id");--> statement-breakpoint
CREATE INDEX "evidence_objects_workspace_idx" ON "evidence_objects" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "evidence_objects_task_idx" ON "evidence_objects" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "evidence_objects_root_task_idx" ON "evidence_objects" USING btree ("root_task_id");--> statement-breakpoint
CREATE INDEX "evidence_objects_worker_idx" ON "evidence_objects" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "evidence_objects_pr_number_idx" ON "evidence_objects" USING btree ("pr_number");--> statement-breakpoint
CREATE INDEX "evidence_objects_backend_idx" ON "evidence_objects" USING btree ("backend_id");--> statement-breakpoint
CREATE INDEX "evidence_objects_task_lineage_idx" ON "evidence_objects" USING btree ("workspace_id","root_task_id","task_id");