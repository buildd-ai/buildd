ALTER TABLE "teams" ADD COLUMN "personal_user_id" uuid;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_personal_user_id_unique" UNIQUE("personal_user_id");--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_personal_user_id_users_id_fkey" FOREIGN KEY ("personal_user_id") REFERENCES "users"("id") ON DELETE SET NULL;