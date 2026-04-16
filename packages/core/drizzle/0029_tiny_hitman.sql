CREATE TABLE IF NOT EXISTS "tenant_budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"team_id" uuid NOT NULL,
	"budget_exhausted_at" timestamp with time zone NOT NULL,
	"budget_resets_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "budget_exhausted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "budget_resets_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_budgets_tenant_team_idx" ON "tenant_budgets" ("tenant_id","team_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_budgets" ADD CONSTRAINT "tenant_budgets_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
