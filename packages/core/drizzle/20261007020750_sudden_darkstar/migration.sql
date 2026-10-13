CREATE TABLE "local_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"workspace_id" uuid,
	"client_kind" text NOT NULL,
	"client_session_hash" text NOT NULL,
	"client_version" text,
	"repo" text,
	"interactive" boolean DEFAULT true NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"bound_worker_id" uuid,
	"bound_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "local_sessions" ADD CONSTRAINT "local_sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_sessions" ADD CONSTRAINT "local_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_sessions" ADD CONSTRAINT "local_sessions_bound_worker_id_workers_id_fk" FOREIGN KEY ("bound_worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "local_sessions_client_idx" ON "local_sessions" USING btree ("account_id","client_kind","client_session_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "local_sessions_bound_worker_idx" ON "local_sessions" USING btree ("bound_worker_id");--> statement-breakpoint
CREATE INDEX "local_sessions_workspace_seen_idx" ON "local_sessions" USING btree ("workspace_id","last_seen_at");