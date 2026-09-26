ALTER TABLE "worker_heartbeats" ADD COLUMN "current_commit" text;--> statement-breakpoint
ALTER TABLE "worker_heartbeats" ADD COLUMN "disk_commit" text;--> statement-breakpoint
ALTER TABLE "worker_heartbeats" ADD COLUMN "commit_drift" boolean;--> statement-breakpoint
ALTER TABLE "worker_heartbeats" ADD COLUMN "updating" boolean;--> statement-breakpoint
ALTER TABLE "worker_heartbeats" ADD COLUMN "update_available" boolean;--> statement-breakpoint
ALTER TABLE "worker_heartbeats" ADD COLUMN "tracked_branch" text;