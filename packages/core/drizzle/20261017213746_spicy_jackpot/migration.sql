CREATE TABLE "workflow_review_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"delivery_id" uuid NOT NULL,
	"round_id" uuid,
	"round" integer NOT NULL,
	"reviewed_head_sha" text NOT NULL,
	"path" text,
	"line" integer,
	"text" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" jsonb,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_review_findings_round_fp_unique" ON "workflow_review_findings" ("delivery_id","round","fingerprint");--> statement-breakpoint
CREATE INDEX "workflow_review_findings_open_idx" ON "workflow_review_findings" ("delivery_id") WHERE "status" = 'open';--> statement-breakpoint
ALTER TABLE "workflow_review_findings" ADD CONSTRAINT "workflow_review_findings_1i9nNeQyORX5_fkey" FOREIGN KEY ("delivery_id") REFERENCES "workflow_deliveries"("id") ON DELETE CASCADE;