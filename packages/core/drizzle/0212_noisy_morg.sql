CREATE TABLE "chat_retros" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"workspace_id" uuid,
	"from_message_id" uuid,
	"to_message_id" uuid,
	"to_message_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"skip_reason" text,
	"user_turns" integer DEFAULT 0 NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" real,
	"intent" text,
	"intent_conf" real,
	"satisfied" text,
	"satisfied_conf" real,
	"wasted_turns" integer DEFAULT 0 NOT NULL,
	"wasted_tokens" integer DEFAULT 0 NOT NULL,
	"primary_cause" text,
	"fix_class" text,
	"fix_class_conf" real,
	"tool_name" text,
	"signature" text,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state_tokens" integer,
	"version" text NOT NULL,
	"latency_ms" integer,
	"jev_cost_usd" real,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "chat_retro" jsonb;--> statement-breakpoint
ALTER TABLE "chat_retros" ADD CONSTRAINT "chat_retros_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_retros" ADD CONSTRAINT "chat_retros_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_retros" ADD CONSTRAINT "chat_retros_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_retros_team_created_idx" ON "chat_retros" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_retros_conversation_watermark_idx" ON "chat_retros" USING btree ("conversation_id","to_message_at");--> statement-breakpoint
CREATE INDEX "chat_retros_team_signature_idx" ON "chat_retros" USING btree ("team_id","signature");