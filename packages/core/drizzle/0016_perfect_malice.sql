CREATE TABLE IF NOT EXISTS "worker_heartbeats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"local_ui_url" text NOT NULL,
	"workspace_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_concurrent_workers" integer DEFAULT 3 NOT NULL,
	"active_worker_count" integer DEFAULT 0 NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_heartbeats_account_idx" ON "worker_heartbeats" ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "worker_heartbeats_local_ui_url_idx" ON "worker_heartbeats" ("account_id","local_ui_url");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_heartbeats_heartbeat_idx" ON "worker_heartbeats" ("last_heartbeat_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "worker_heartbeats" ADD CONSTRAINT "worker_heartbeats_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
