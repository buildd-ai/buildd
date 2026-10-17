CREATE TABLE "workflow_command_outbox" (
	"idempotency_key" text PRIMARY KEY,
	"op" text NOT NULL,
	"input" jsonb NOT NULL,
	"principal" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"prior_unknown" boolean DEFAULT false NOT NULL,
	"outcome" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "workflow_command_outbox_due_idx" ON "workflow_command_outbox" ("not_before") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX "workflow_command_outbox_created_idx" ON "workflow_command_outbox" ("created_at");