ALTER TABLE "initiatives" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "initiatives" ADD COLUMN "target_date" date;--> statement-breakpoint
ALTER TABLE "initiatives" ADD CONSTRAINT "initiatives_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;