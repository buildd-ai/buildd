ALTER TABLE "spec_discrepancies" ADD COLUMN "doc_fix_task_id" uuid;--> statement-breakpoint
ALTER TABLE "spec_discrepancies" ADD COLUMN "proposal_rejected_reason" text;--> statement-breakpoint
ALTER TABLE "spec_discrepancies" ADD CONSTRAINT "spec_discrepancies_doc_fix_task_id_tasks_id_fk" FOREIGN KEY ("doc_fix_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spec_discrepancies_spec_path_idx" ON "spec_discrepancies" USING btree ("workspace_id","spec_path");