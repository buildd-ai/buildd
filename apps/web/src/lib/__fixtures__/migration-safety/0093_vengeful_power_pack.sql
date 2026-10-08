CREATE TABLE "external_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"buildd_entity_type" text NOT NULL,
	"buildd_entity_id" uuid NOT NULL,
	"external_id" text,
	"external_url" text,
	"external_updated_at" timestamp with time zone,
	"last_pushed_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "external_links" ADD CONSTRAINT "external_links_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_links_provider_external_idx" ON "external_links" USING btree ("provider","external_id") WHERE "external_links"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "external_links_entity_idx" ON "external_links" USING btree ("buildd_entity_type","buildd_entity_id");--> statement-breakpoint
CREATE INDEX "external_links_team_idx" ON "external_links" USING btree ("team_id");