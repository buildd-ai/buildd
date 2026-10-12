CREATE TABLE "presence_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "local_sessions" ALTER COLUMN "account_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "local_sessions" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "presence_tokens" ADD CONSTRAINT "presence_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "presence_tokens_user_idx" ON "presence_tokens" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "local_sessions" ADD CONSTRAINT "local_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "local_sessions_user_client_idx" ON "local_sessions" USING btree ("user_id","client_kind","client_session_hash");--> statement-breakpoint
ALTER TABLE "local_sessions" ADD CONSTRAINT "local_sessions_one_owner" CHECK (num_nonnulls("local_sessions"."account_id", "local_sessions"."user_id") = 1);