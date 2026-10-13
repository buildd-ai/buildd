DROP INDEX "ws_skills_team_slug_idx";--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "credential_policy" text;--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD COLUMN "visibility" text DEFAULT 'team' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD CONSTRAINT "workspace_skills_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_created_by_user_idx" ON "tasks" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ws_skills_owner_slug_idx" ON "workspace_skills" USING btree ("team_id","owner_user_id","slug") WHERE "workspace_skills"."owner_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ws_skills_team_slug_idx" ON "workspace_skills" USING btree ("team_id","slug") WHERE "workspace_skills"."workspace_id" IS NULL AND "workspace_skills"."owner_user_id" IS NULL;