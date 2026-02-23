CREATE TABLE IF NOT EXISTS "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"account_id" uuid,
	"workspace_id" uuid,
	"purpose" text NOT NULL,
	"label" text,
	"encrypted_value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "secret_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref" text NOT NULL UNIQUE,
	"secret_id" uuid NOT NULL,
	"scoped_to_worker_id" text NOT NULL,
	"redeemed" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "secrets" ADD CONSTRAINT "secrets_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "secrets" ADD CONSTRAINT "secrets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "secrets" ADD CONSTRAINT "secrets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "secret_refs" ADD CONSTRAINT "secret_refs_secret_id_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "secrets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secrets_team_idx" ON "secrets" ("team_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "secrets_account_purpose_idx" ON "secrets" ("account_id","purpose");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "secret_refs_ref_idx" ON "secret_refs" ("ref");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_refs_secret_idx" ON "secret_refs" ("secret_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_refs_expires_idx" ON "secret_refs" ("expires_at");
