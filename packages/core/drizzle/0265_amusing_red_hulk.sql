CREATE TABLE "trunk_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repo_full_name" text NOT NULL,
	"base_ref" text NOT NULL,
	"signature" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_by_fact" uuid,
	"trunk_fix_task_id" uuid,
	"affected_deliveries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"family" text NOT NULL,
	"attempt_no" integer NOT NULL,
	"mode" text NOT NULL,
	"bound_head_sha" text,
	"trigger_fact_id" uuid,
	"trigger_reason" text,
	"task_id" uuid,
	"trigger" text DEFAULT 'automatic' NOT NULL,
	"reported_shas" text[] DEFAULT '{}'::text[] NOT NULL,
	"pushed_head_sha" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"outcome" text,
	"max_attempts" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_task_id" uuid NOT NULL,
	"repo_full_name" text,
	"pr_number" integer,
	"base_ref" text,
	"state" text NOT NULL,
	"state_reason" text,
	"version" bigint DEFAULT 0 NOT NULL,
	"current_head_sha" text,
	"current_round" integer DEFAULT 0 NOT NULL,
	"max_rounds" integer DEFAULT 3 NOT NULL,
	"bound_attempt_id" uuid,
	"resume_state" text,
	"trunk_incident_id" uuid,
	"approved_heads" text[] DEFAULT '{}'::text[] NOT NULL,
	"approval_basis" text,
	"composition_heads" text[] DEFAULT '{}'::text[] NOT NULL,
	"ci" text,
	"ci_head_sha" text,
	"mergeable" text,
	"mergeable_head_sha" text,
	"merged_at" timestamp with time zone,
	"merge_commit_sha" text,
	"superseded_by_pr" integer,
	"superseded_by_url" text,
	"superseded_reason" text,
	"recorded_by" text,
	"authority" text DEFAULT 'kernel' NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_transition_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"transition_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"delivery_id" uuid,
	"repo_full_name" text,
	"pr_number" integer,
	"kind" text NOT NULL,
	"fact_key" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"applied_transition_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_review_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"head_sha" text NOT NULL,
	"kind" text NOT NULL,
	"prior_round" integer,
	"scope" jsonb,
	"reviewer_task_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"verdict" text,
	"effective_verdict" text,
	"confidence" real,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"from_version" bigint NOT NULL,
	"to_version" bigint NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"command" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"actor" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bypass" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "delivery_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "delivery_role" text;--> statement-breakpoint
ALTER TABLE "trunk_incidents" ADD CONSTRAINT "trunk_incidents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trunk_incidents" ADD CONSTRAINT "trunk_incidents_trunk_fix_task_id_tasks_id_fk" FOREIGN KEY ("trunk_fix_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_attempts" ADD CONSTRAINT "workflow_attempts_delivery_id_workflow_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."workflow_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_attempts" ADD CONSTRAINT "workflow_attempts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_deliveries" ADD CONSTRAINT "workflow_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_deliveries" ADD CONSTRAINT "workflow_deliveries_owner_task_id_tasks_id_fk" FOREIGN KEY ("owner_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_effects" ADD CONSTRAINT "workflow_effects_delivery_id_workflow_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."workflow_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_effects" ADD CONSTRAINT "workflow_effects_transition_id_workflow_transitions_id_fk" FOREIGN KEY ("transition_id") REFERENCES "public"."workflow_transitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_facts" ADD CONSTRAINT "workflow_facts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_facts" ADD CONSTRAINT "workflow_facts_delivery_id_workflow_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."workflow_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_rounds" ADD CONSTRAINT "workflow_review_rounds_delivery_id_workflow_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."workflow_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_rounds" ADD CONSTRAINT "workflow_review_rounds_reviewer_task_id_tasks_id_fk" FOREIGN KEY ("reviewer_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_delivery_id_workflow_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."workflow_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trunk_incidents_open_signature_unique" ON "trunk_incidents" USING btree ("workspace_id","repo_full_name","base_ref","signature") WHERE "trunk_incidents"."status" <> 'resolved';--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_attempts_no_unique" ON "workflow_attempts" USING btree ("delivery_id","family","mode","attempt_no");--> statement-breakpoint
CREATE INDEX "workflow_attempts_task_idx" ON "workflow_attempts" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_deliveries_owner_unique" ON "workflow_deliveries" USING btree ("workspace_id","owner_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_deliveries_pr_unique" ON "workflow_deliveries" USING btree ("workspace_id","repo_full_name","pr_number") WHERE "workflow_deliveries"."pr_number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "workflow_deliveries_state_idx" ON "workflow_deliveries" USING btree ("workspace_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_effects_dedupe_unique" ON "workflow_effects" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "workflow_effects_due_idx" ON "workflow_effects" USING btree ("not_before") WHERE "workflow_effects"."status" IN ('pending', 'delivering');--> statement-breakpoint
CREATE INDEX "workflow_effects_delivery_idx" ON "workflow_effects" USING btree ("delivery_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_facts_fact_key_unique" ON "workflow_facts" USING btree ("workspace_id","fact_key");--> statement-breakpoint
CREATE INDEX "workflow_facts_delivery_idx" ON "workflow_facts" USING btree ("delivery_id","observed_at");--> statement-breakpoint
CREATE INDEX "workflow_facts_pr_idx" ON "workflow_facts" USING btree ("workspace_id","repo_full_name","pr_number");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_review_rounds_round_unique" ON "workflow_review_rounds" USING btree ("delivery_id","round");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_review_rounds_open_per_head" ON "workflow_review_rounds" USING btree ("delivery_id","head_sha","kind") WHERE "workflow_review_rounds"."status" IN ('queued', 'reviewing');--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_transitions_idempotency_unique" ON "workflow_transitions" USING btree ("delivery_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_transitions_version_unique" ON "workflow_transitions" USING btree ("delivery_id","to_version");--> statement-breakpoint
CREATE INDEX "tasks_delivery_idx" ON "tasks" USING btree ("delivery_id") WHERE "tasks"."delivery_id" IS NOT NULL;