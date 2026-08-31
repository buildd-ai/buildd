ALTER TABLE "mission_notes" ADD COLUMN "delivered_to" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "supports_instruction_ack" boolean DEFAULT false NOT NULL;