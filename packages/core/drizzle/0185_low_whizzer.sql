CREATE TABLE "chat_turn_windows" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"turn_at" timestamp with time zone[] DEFAULT '{}'::timestamptz[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "chat_user_daily_budget_usd" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "chat_turn_windows" ADD CONSTRAINT "chat_turn_windows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;