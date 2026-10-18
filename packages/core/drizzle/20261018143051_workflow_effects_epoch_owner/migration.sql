ALTER TABLE "workflow_effects" ADD COLUMN "epoch_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_effects" ALTER COLUMN "delivery_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_effects" ALTER COLUMN "transition_id" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "workflow_effects_epoch_idx" ON "workflow_effects" ("epoch_id","created_at") WHERE "epoch_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_effects" ADD CONSTRAINT "workflow_effects_epoch_id_workflow_mission_epochs_id_fkey" FOREIGN KEY ("epoch_id") REFERENCES "workflow_mission_epochs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_effects" ADD CONSTRAINT "workflow_effects_one_owner" CHECK (("epoch_id" IS NULL AND "delivery_id" IS NOT NULL AND "transition_id" IS NOT NULL) OR ("epoch_id" IS NOT NULL AND "delivery_id" IS NULL AND "transition_id" IS NULL));