ALTER TABLE "workflow_findings" ADD COLUMN "remedy_class" text DEFAULT 'code_fix' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_findings" ADD COLUMN "restated_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_findings" ADD COLUMN "evidence" jsonb;