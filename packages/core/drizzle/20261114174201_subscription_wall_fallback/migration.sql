ALTER TABLE "teams" ADD COLUMN "subscription_wall_fallback" jsonb;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "wall_fallback" jsonb;--> statement-breakpoint
CREATE INDEX "workers_wall_fallback_created_idx" ON "workers" ("created_at") WHERE "wall_fallback" IS NOT NULL;