DROP INDEX "model_tier_registry_unique";--> statement-breakpoint
ALTER TABLE "model_tier_registry" ADD COLUMN "surface" text;--> statement-breakpoint
CREATE UNIQUE INDEX "model_tier_registry_unique" ON "model_tier_registry" USING btree ("team_id","workspace_id","tier","surface");