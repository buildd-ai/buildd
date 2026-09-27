CREATE TABLE "tier_pool_arms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid NOT NULL,
	"route" text NOT NULL,
	"model" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"source" text DEFAULT 'admin' NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tier_pool_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"evidence" jsonb,
	"actor_user_id" uuid,
	"actor_system" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tier_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid,
	"tier" text NOT NULL,
	"surface" text NOT NULL,
	"mode" text DEFAULT 'pinned' NOT NULL,
	"experiment_id" uuid,
	"allocation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"allocation_version" integer DEFAULT 1 NOT NULL,
	"incumbent_floor" real DEFAULT 0.6 NOT NULL,
	"exploration_cap" real DEFAULT 0.3 NOT NULL,
	"challenger_min" real DEFAULT 0.05 NOT NULL,
	"max_step" real DEFAULT 0.1 NOT NULL,
	"cost_weight" real DEFAULT 0.1 NOT NULL,
	"latency_weight" real DEFAULT 0.05 NOT NULL,
	"challenger_daily_cap" numeric(10, 2),
	"auto_challenger" boolean DEFAULT false NOT NULL,
	"auto_shift" boolean DEFAULT false NOT NULL,
	"frozen_at" timestamp with time zone,
	"frozen_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tier_pools_scope_unique" UNIQUE NULLS NOT DISTINCT("team_id","workspace_id","tier","surface")
);
--> statement-breakpoint
ALTER TABLE "experiment_assignments" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "experiment_assignments" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "experiment_assignments" ADD COLUMN "message_id" uuid;--> statement-breakpoint
ALTER TABLE "experiment_assignments" ADD COLUMN "arm_id" uuid;--> statement-breakpoint
ALTER TABLE "experiment_assignments" ADD COLUMN "allocation_version" integer;--> statement-breakpoint
ALTER TABLE "user_feedback" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "tier_pool_arms" ADD CONSTRAINT "tier_pool_arms_pool_id_tier_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."tier_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tier_pool_arms" ADD CONSTRAINT "tier_pool_arms_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tier_pool_changes" ADD CONSTRAINT "tier_pool_changes_pool_id_tier_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."tier_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tier_pool_changes" ADD CONSTRAINT "tier_pool_changes_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tier_pools" ADD CONSTRAINT "tier_pools_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tier_pools" ADD CONSTRAINT "tier_pools_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tier_pools" ADD CONSTRAINT "tier_pools_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tier_pools" ADD CONSTRAINT "tier_pools_frozen_by_users_id_fk" FOREIGN KEY ("frozen_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tier_pool_arms_pool_idx" ON "tier_pool_arms" USING btree ("pool_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tier_pool_arms_live_unique" ON "tier_pool_arms" USING btree ("pool_id","route","model") WHERE "tier_pool_arms"."status" <> 'removed';--> statement-breakpoint
CREATE UNIQUE INDEX "tier_pool_arms_one_incumbent" ON "tier_pool_arms" USING btree ("pool_id") WHERE "tier_pool_arms"."role" = 'incumbent' AND "tier_pool_arms"."status" <> 'removed';--> statement-breakpoint
CREATE INDEX "tier_pool_changes_pool_created_idx" ON "tier_pool_changes" USING btree ("pool_id","created_at");--> statement-breakpoint
CREATE INDEX "tier_pools_team_idx" ON "tier_pools" USING btree ("team_id");--> statement-breakpoint
ALTER TABLE "experiment_assignments" ADD CONSTRAINT "experiment_assignments_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_assignments" ADD CONSTRAINT "experiment_assignments_message_id_conversation_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_assignments" ADD CONSTRAINT "experiment_assignments_arm_id_tier_pool_arms_id_fk" FOREIGN KEY ("arm_id") REFERENCES "public"."tier_pool_arms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "experiment_assignments_experiment_message_idx" ON "experiment_assignments" USING btree ("experiment_id","message_id") WHERE "experiment_assignments"."message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "experiment_assignments_arm_idx" ON "experiment_assignments" USING btree ("arm_id");--> statement-breakpoint
ALTER TABLE "experiment_assignments" ADD CONSTRAINT "experiment_assignments_task_or_message" CHECK ("experiment_assignments"."task_id" IS NOT NULL OR "experiment_assignments"."message_id" IS NOT NULL);