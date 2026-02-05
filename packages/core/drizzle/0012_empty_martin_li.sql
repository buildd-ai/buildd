ALTER TABLE "users" ALTER COLUMN "google_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "github_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_github_id_idx" ON "users" ("github_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_github_id_unique" UNIQUE("github_id");