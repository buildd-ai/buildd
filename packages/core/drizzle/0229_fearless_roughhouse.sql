ALTER TABLE "orchestration_manifest_predictions" ADD COLUMN "set_confidence" real;--> statement-breakpoint
ALTER TABLE "orchestration_manifest_predictions" ADD COLUMN "expected_size" jsonb;