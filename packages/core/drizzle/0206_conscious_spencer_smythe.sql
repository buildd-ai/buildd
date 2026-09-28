CREATE TABLE "chat_directives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid,
	"text" text NOT NULL,
	"source" text DEFAULT 'chat' NOT NULL,
	"source_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_directives_user_scope_text_unique" UNIQUE NULLS NOT DISTINCT("user_id","workspace_id","text")
);
--> statement-breakpoint
CREATE TABLE "memory_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid,
	"task_id" uuid,
	"memory_id" text,
	"decision" text NOT NULL,
	"version" text NOT NULL,
	"mode" text NOT NULL,
	"verdict" text,
	"confidence" real,
	"probability" real,
	"rule" text,
	"applied" boolean DEFAULT false NOT NULL,
	"error" text,
	"caller" text,
	"latency_ms" integer,
	"cost_usd" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_extraction_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_uses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid,
	"task_id" uuid,
	"worker_id" uuid,
	"chunk_id" text,
	"memory_id" text NOT NULL,
	"caller" text NOT NULL,
	"via" text NOT NULL,
	"rank" integer NOT NULL,
	"score" real,
	"gated_by" text,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ALTER COLUMN "account_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "superseded_by" uuid;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "index_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "state" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "source_kind" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "external" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "valid_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "invalidated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "reverify_flagged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "reverify_ref" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "corroborated_by" uuid;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "pending_supersedes" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_directives" ADD CONSTRAINT "chat_directives_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_directives" ADD CONSTRAINT "chat_directives_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_decisions" ADD CONSTRAINT "memory_decisions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_extraction_attempts" ADD CONSTRAINT "memory_extraction_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_directives_user_created_idx" ON "chat_directives" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_decisions_team_decision_idx" ON "memory_decisions" USING btree ("team_id","decision","created_at");--> statement-breakpoint
CREATE INDEX "memory_decisions_task_idx" ON "memory_decisions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "memory_decisions_memory_idx" ON "memory_decisions" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX "memory_decisions_created_idx" ON "memory_decisions" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_extraction_attempts_source_unique" ON "memory_extraction_attempts" USING btree ("source_kind","source_id");--> statement-breakpoint
CREATE INDEX "memory_uses_memory_idx" ON "memory_uses" USING btree ("team_id","memory_id");--> statement-breakpoint
CREATE INDEX "memory_uses_task_idx" ON "memory_uses" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "memory_uses_created_idx" ON "memory_uses" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "memories_state_created_idx" ON "memories" USING btree ("state","created_at");