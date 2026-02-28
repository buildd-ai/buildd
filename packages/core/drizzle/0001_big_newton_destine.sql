CREATE TABLE IF NOT EXISTS "file_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"file_path" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "file_reservations_workspace_file_idx" ON "file_reservations" ("workspace_id","file_path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_reservations_worker_idx" ON "file_reservations" ("worker_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_reservations_expires_idx" ON "file_reservations" ("expires_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "file_reservations" ADD CONSTRAINT "file_reservations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "file_reservations" ADD CONSTRAINT "file_reservations_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
