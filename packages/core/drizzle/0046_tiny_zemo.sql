ALTER TABLE "missions" ADD COLUMN "requires_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "requires_review" boolean DEFAULT false NOT NULL;