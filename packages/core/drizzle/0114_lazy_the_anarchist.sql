CREATE TABLE "path_claim_waiters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"blocking_task_id" uuid NOT NULL,
	"waiting_task_id" uuid NOT NULL,
	"blocked_path" text NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "path_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"path" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "path_claim_waiters" ADD CONSTRAINT "path_claim_waiters_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "path_claim_waiters" ADD CONSTRAINT "path_claim_waiters_blocking_task_id_tasks_id_fk" FOREIGN KEY ("blocking_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "path_claim_waiters" ADD CONSTRAINT "path_claim_waiters_waiting_task_id_tasks_id_fk" FOREIGN KEY ("waiting_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "path_claims" ADD CONSTRAINT "path_claims_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "path_claims" ADD CONSTRAINT "path_claims_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "path_claim_waiters_unique_idx" ON "path_claim_waiters" USING btree ("blocking_task_id","waiting_task_id","blocked_path");--> statement-breakpoint
CREATE INDEX "path_claim_waiters_blocking_idx" ON "path_claim_waiters" USING btree ("blocking_task_id");--> statement-breakpoint
CREATE INDEX "path_claim_waiters_starvation_idx" ON "path_claim_waiters" USING btree ("workspace_id","registered_at") WHERE "path_claim_waiters"."notified_at" IS NULL;--> statement-breakpoint
CREATE INDEX "path_claims_active_idx" ON "path_claims" USING btree ("workspace_id","path") WHERE "path_claims"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "path_claims_task_idx" ON "path_claims" USING btree ("task_id") WHERE "path_claims"."released_at" IS NULL;