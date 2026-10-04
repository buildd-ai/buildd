CREATE TABLE "task_dispatch_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"cause" text NOT NULL,
	"causes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"dedupe_key" text DEFAULT 'now' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"delivered_via" text,
	"last_error" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_dispatch_outbox" ADD CONSTRAINT "task_dispatch_outbox_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dispatch_outbox" ADD CONSTRAINT "task_dispatch_outbox_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_dispatch_outbox_pending_dedupe_idx" ON "task_dispatch_outbox" USING btree ("task_id","dedupe_key") WHERE "task_dispatch_outbox"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "task_dispatch_outbox_due_idx" ON "task_dispatch_outbox" USING btree ("not_before") WHERE "task_dispatch_outbox"."status" IN ('pending', 'delivering');--> statement-breakpoint
CREATE INDEX "task_dispatch_outbox_task_idx" ON "task_dispatch_outbox" USING btree ("task_id","created_at");