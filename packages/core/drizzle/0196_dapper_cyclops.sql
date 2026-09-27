CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"dedupe_key" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"urgency" text DEFAULT 'normal' NOT NULL,
	"route" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid,
	"owner_user_id" uuid,
	"owner_task_id" uuid,
	"owner_account_id" uuid,
	"conversation_id" uuid,
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"subject_ref" jsonb NOT NULL,
	"event_types" text[] NOT NULL,
	"lifetime" text DEFAULT 'one_shot' NOT NULL,
	"created_via" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_exactly_one_owner" CHECK (num_nonnulls("subscriptions"."owner_user_id", "subscriptions"."owner_task_id", "subscriptions"."owner_account_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_owner_task_id_tasks_id_fk" FOREIGN KEY ("owner_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_subscription_dedupe_idx" ON "notification_deliveries" USING btree ("subscription_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "notification_deliveries_pending_idx" ON "notification_deliveries" USING btree ("subscription_id","created_at") WHERE "notification_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "subscriptions_subject_idx" ON "subscriptions" USING btree ("subject_kind","subject_key") WHERE "subscriptions"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "subscriptions_owner_user_idx" ON "subscriptions" USING btree ("owner_user_id") WHERE "subscriptions"."owner_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "subscriptions_owner_task_idx" ON "subscriptions" USING btree ("owner_task_id") WHERE "subscriptions"."owner_task_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "subscriptions_owner_account_idx" ON "subscriptions" USING btree ("owner_account_id") WHERE "subscriptions"."owner_account_id" IS NOT NULL;