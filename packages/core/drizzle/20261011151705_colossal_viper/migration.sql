CREATE TABLE "decision_feature_modes" (
	"feature" text PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"applying_fraction" real DEFAULT 1 NOT NULL,
	"measured_fingerprint" text,
	"threshold" real,
	"set_by_account_id" uuid,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text
);
