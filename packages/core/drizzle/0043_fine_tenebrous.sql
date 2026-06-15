DO $$ BEGIN
 CREATE TYPE "agent_backend" AS ENUM('claude', 'codex');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "backend" "agent_backend" DEFAULT 'claude' NOT NULL;