CREATE TABLE IF NOT EXISTS "mission_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"task_id" uuid,
	"worker_id" uuid,
	"author_type" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"reply_to" uuid,
	"default_choice" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_notes_mission_idx" ON "mission_notes" ("mission_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_notes_reply_to_idx" ON "mission_notes" ("reply_to");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_notes_type_idx" ON "mission_notes" ("type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_notes_status_idx" ON "mission_notes" ("status");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mission_notes" ADD CONSTRAINT "mission_notes_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "missions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
