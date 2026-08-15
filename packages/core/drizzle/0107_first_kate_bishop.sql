ALTER TABLE "workers" ADD COLUMN "subagent_spans" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "subagent_spans_observed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "background_agent_ms" integer DEFAULT 0 NOT NULL;