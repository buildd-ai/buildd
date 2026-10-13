ALTER TABLE "decision_model_measurements" ADD COLUMN "confidence_source" text DEFAULT 'confidence' NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_model_measurements" ADD COLUMN "calibration" jsonb;--> statement-breakpoint
ALTER TABLE "decision_model_measurements" ADD COLUMN "label_thresholds" jsonb;