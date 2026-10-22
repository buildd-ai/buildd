ALTER TABLE "missions" ADD COLUMN "created_by_account_id" uuid;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "created_by_worker_id" uuid;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "created_by_task_id" uuid;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "requester_source" text;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_created_by_account_id_accounts_id_fkey" FOREIGN KEY ("created_by_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL;