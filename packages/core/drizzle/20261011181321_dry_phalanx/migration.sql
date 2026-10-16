CREATE TABLE "decision_model_measurements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"threshold" real NOT NULL,
	"precision_lower" real,
	"coverage" real,
	"n" integer NOT NULL,
	"eval_run_id" text,
	"measured_fingerprint" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"set_by_account_id" uuid,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "decision_model_measurements_kind_model_idx" ON "decision_model_measurements" USING btree ("kind","model");