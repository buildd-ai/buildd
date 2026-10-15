CREATE TABLE "workflow_findings" (
	"id" text PRIMARY KEY,
	"delivery_id" uuid NOT NULL,
	"origin_round_id" uuid NOT NULL,
	"origin_round" integer NOT NULL,
	"origin_head_sha" text NOT NULL,
	"ordinal" integer NOT NULL,
	"path" text,
	"line" integer,
	"title" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"last_round" integer NOT NULL,
	"addressed_by_sha" text,
	"closed_by_round_id" uuid,
	"closed_by" text,
	"closed_reason" text,
	"deferred_to_task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "workflow_findings_delivery_idx" ON "workflow_findings" ("delivery_id","origin_round","ordinal");--> statement-breakpoint
ALTER TABLE "workflow_findings" ADD CONSTRAINT "workflow_findings_delivery_id_workflow_deliveries_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "workflow_deliveries"("id") ON DELETE CASCADE;