ALTER TABLE "evidence_objects" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_objects" ALTER COLUMN "root_task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_objects" ALTER COLUMN "worker_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_objects" ADD COLUMN "scout_run_id" uuid;--> statement-breakpoint
ALTER TABLE "evidence_objects" ADD CONSTRAINT "evidence_objects_scout_run_id_quality_scout_runs_id_fk" FOREIGN KEY ("scout_run_id") REFERENCES "public"."quality_scout_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_objects_scout_run_idx" ON "evidence_objects" USING btree ("scout_run_id");--> statement-breakpoint
ALTER TABLE "evidence_objects" ADD CONSTRAINT "evidence_objects_one_owner" CHECK (("evidence_objects"."scout_run_id" IS NULL AND "evidence_objects"."task_id" IS NOT NULL AND "evidence_objects"."root_task_id" IS NOT NULL AND "evidence_objects"."worker_id" IS NOT NULL)
      OR ("evidence_objects"."scout_run_id" IS NOT NULL AND "evidence_objects"."task_id" IS NULL AND "evidence_objects"."root_task_id" IS NULL AND "evidence_objects"."worker_id" IS NULL));