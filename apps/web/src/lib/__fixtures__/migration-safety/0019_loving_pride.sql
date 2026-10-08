ALTER TABLE "workspace_skills" ADD COLUMN IF NOT EXISTS "account_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_skills_account_idx" ON "workspace_skills" ("account_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_skills" ADD CONSTRAINT "workspace_skills_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
