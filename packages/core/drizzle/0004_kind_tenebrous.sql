ALTER TABLE "workers" ADD COLUMN "last_commit_sha" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "commit_count" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "files_changed" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "lines_added" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "lines_removed" integer DEFAULT 0;