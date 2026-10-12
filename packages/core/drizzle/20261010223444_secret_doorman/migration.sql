CREATE TABLE "artifact_reads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"workspace_id" uuid,
	"account_id" uuid,
	"user_id" uuid,
	"task_id" uuid,
	"view" text NOT NULL,
	"selector" jsonb,
	"returned_chars" integer NOT NULL,
	"total_chars" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "artifact_reads_artifact_idx" ON "artifact_reads" USING btree ("artifact_id","created_at");--> statement-breakpoint
CREATE INDEX "artifact_reads_task_idx" ON "artifact_reads" USING btree ("task_id");