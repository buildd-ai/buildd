-- Make artifacts.worker_id nullable to support mission-level artifacts (no worker context)
--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "worker_id" DROP NOT NULL;
