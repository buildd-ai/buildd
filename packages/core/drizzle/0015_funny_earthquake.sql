DROP INDEX IF EXISTS "secrets_account_purpose_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "secrets_account_purpose_label_idx" ON "secrets" ("account_id","purpose","label");