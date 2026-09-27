CREATE TABLE "ai_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"workspace_id" uuid,
	"requested_tier" text NOT NULL,
	"tier" text NOT NULL,
	"surface" text NOT NULL,
	"kind" text NOT NULL,
	"provider" text,
	"model" text,
	"source" text NOT NULL,
	"pool_id" uuid,
	"arm_id" uuid,
	"action" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"plan_id" uuid,
	"tier" text NOT NULL,
	"surface" text,
	"kind" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"plan_source" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) NOT NULL,
	"cost_source" text NOT NULL,
	"latency_ms" integer NOT NULL,
	"outcome" text NOT NULL,
	"feedback" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "ai_daily_budget_usd" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "ai_plans" ADD CONSTRAINT "ai_plans_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_plans" ADD CONSTRAINT "ai_plans_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_plans" ADD CONSTRAINT "ai_plans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_plans" ADD CONSTRAINT "ai_plans_pool_id_tier_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."tier_pools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_plans" ADD CONSTRAINT "ai_plans_arm_id_tier_pool_arms_id_fk" FOREIGN KEY ("arm_id") REFERENCES "public"."tier_pool_arms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_plan_id_ai_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."ai_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_plans_team_created_idx" ON "ai_plans" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_plans_account_created_idx" ON "ai_plans" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_account_created_idx" ON "ai_usage" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_team_created_idx" ON "ai_usage" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_plan_idx" ON "ai_usage" USING btree ("plan_id");