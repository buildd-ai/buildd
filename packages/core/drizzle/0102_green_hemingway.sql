CREATE TABLE "oauth_budget_episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"exhausted_at" timestamp with time zone NOT NULL,
	"resets_at" timestamp with time zone,
	"worker_count" integer DEFAULT 0 NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"weighted_turns" integer DEFAULT 0 NOT NULL,
	"weighted_tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_budget_episodes" ADD CONSTRAINT "oauth_budget_episodes_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_budget_episodes_account_exhausted_idx" ON "oauth_budget_episodes" USING btree ("account_id","exhausted_at");