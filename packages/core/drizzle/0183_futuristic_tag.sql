ALTER TABLE "secrets" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_personal_inference_key_idx" ON "secrets" USING btree ("team_id","user_id","label") WHERE "secrets"."purpose" = 'inference_key' and "secrets"."user_id" is not null and "secrets"."workspace_id" is null;--> statement-breakpoint
CREATE INDEX "secrets_user_idx" ON "secrets" USING btree ("user_id");