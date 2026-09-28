CREATE TABLE "memory_extraction_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "state" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "source_kind" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "external" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "valid_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "invalidated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "reverify_flagged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "reverify_ref" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "corroborated_by" uuid;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "pending_supersedes" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_extraction_attempts" ADD CONSTRAINT "memory_extraction_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_extraction_attempts_source_unique" ON "memory_extraction_attempts" USING btree ("source_kind","source_id");--> statement-breakpoint
CREATE INDEX "memories_state_created_idx" ON "memories" USING btree ("state","created_at");