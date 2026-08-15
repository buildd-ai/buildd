CREATE TABLE "change_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"surface" text NOT NULL,
	"task_id" uuid,
	"pr_number" integer,
	"branch" text,
	"head_sha" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "last_migration_number" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "change_intents" ADD CONSTRAINT "change_intents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_intents" ADD CONSTRAINT "change_intents_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_intents_ws_surface_open_idx" ON "change_intents" USING btree ("workspace_id","surface") WHERE "change_intents"."closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "change_intents_task_idx" ON "change_intents" USING btree ("task_id");