ALTER TABLE "task_dispatch_outbox" ADD COLUMN "transport" text DEFAULT 'in_app' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_dispatch_outbox" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_dispatch_outbox" ADD COLUMN "handed_off_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_dispatch_outbox" ADD COLUMN "merged_into" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "dispatch_transport" text DEFAULT 'in_app' NOT NULL;--> statement-breakpoint
CREATE INDEX "task_dispatch_outbox_unacked_idx" ON "task_dispatch_outbox" USING btree ("created_at") WHERE "task_dispatch_outbox"."status" = 'pending' AND "task_dispatch_outbox"."handed_off_at" IS NULL;--> statement-breakpoint
CREATE INDEX "task_dispatch_outbox_handed_off_idx" ON "task_dispatch_outbox" USING btree ("not_before") WHERE "task_dispatch_outbox"."status" = 'handed_off';