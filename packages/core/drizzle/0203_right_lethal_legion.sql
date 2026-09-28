CREATE TABLE "memory_uses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid,
	"task_id" uuid,
	"worker_id" uuid,
	"chunk_id" text,
	"memory_id" text NOT NULL,
	"caller" text NOT NULL,
	"via" text NOT NULL,
	"rank" integer NOT NULL,
	"score" real,
	"gated_by" text,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "memory_uses_memory_idx" ON "memory_uses" USING btree ("team_id","memory_id");--> statement-breakpoint
CREATE INDEX "memory_uses_task_idx" ON "memory_uses" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "memory_uses_created_idx" ON "memory_uses" USING btree ("created_at");