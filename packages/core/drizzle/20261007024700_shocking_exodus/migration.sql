CREATE TABLE "connector_catalog_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"auth_mode" "connector_auth_mode" DEFAULT 'oauth' NOT NULL,
	"header_name" text,
	"description" text DEFAULT '' NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"icon_url" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_catalog_team_policies" (
	"team_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"policy" text NOT NULL,
	"updated_by_account_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_catalog_team_policies_team_id_slug_pk" PRIMARY KEY("team_id","slug")
);
--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ADD CONSTRAINT "connector_catalog_entries_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ADD CONSTRAINT "connector_catalog_entries_created_by_account_id_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_catalog_team_policies" ADD CONSTRAINT "connector_catalog_team_policies_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_catalog_team_policies" ADD CONSTRAINT "connector_catalog_team_policies_updated_by_account_id_accounts_id_fk" FOREIGN KEY ("updated_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_catalog_platform_slug_idx" ON "connector_catalog_entries" USING btree ("slug") WHERE "connector_catalog_entries"."team_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_catalog_team_slug_idx" ON "connector_catalog_entries" USING btree ("team_id","slug") WHERE "connector_catalog_entries"."team_id" IS NOT NULL;