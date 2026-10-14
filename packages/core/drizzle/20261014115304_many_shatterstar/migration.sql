CREATE TABLE "workflow_commands" (
	"idempotency_key" text PRIMARY KEY,
	"op" text NOT NULL,
	"principal" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"response" jsonb,
	"delivery_id" uuid,
	"delivery_version" bigint,
	"host" text NOT NULL,
	"claim_token" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD COLUMN "host" text;--> statement-breakpoint
CREATE INDEX "workflow_commands_created_idx" ON "workflow_commands" ("created_at");