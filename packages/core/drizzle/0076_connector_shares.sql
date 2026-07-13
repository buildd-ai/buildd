CREATE TABLE "connector_shares" (
	"connector_id" uuid NOT NULL,
	"shared_with_team_id" uuid NOT NULL,
	"granted_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_shares_connector_id_shared_with_team_id_pk" PRIMARY KEY("connector_id","shared_with_team_id")
);
--> statement-breakpoint
ALTER TABLE "connector_shares" ADD CONSTRAINT "connector_shares_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_shares" ADD CONSTRAINT "connector_shares_shared_with_team_id_teams_id_fk" FOREIGN KEY ("shared_with_team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_shares" ADD CONSTRAINT "connector_shares_granted_by_account_id_accounts_id_fk" FOREIGN KEY ("granted_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_shares_shared_with_team_idx" ON "connector_shares" USING btree ("shared_with_team_id");