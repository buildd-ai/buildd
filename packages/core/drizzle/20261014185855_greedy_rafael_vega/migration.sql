ALTER TABLE "account_workspaces" ADD COLUMN "granted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "account_workspaces" ADD COLUMN "created_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "account_workspaces" ADD CONSTRAINT "account_workspaces_granted_by_user_id_users_id_fkey" FOREIGN KEY ("granted_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE;