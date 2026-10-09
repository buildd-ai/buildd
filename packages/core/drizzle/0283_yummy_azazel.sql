CREATE TABLE "mcp_oauth_grant_workspaces" (
	"grant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_grant_workspaces_grant_id_workspace_id_pk" PRIMARY KEY("grant_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"acts_as" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_grants_acts_as_valid" CHECK ("mcp_oauth_grants"."acts_as" in ('person', 'agent')),
	CONSTRAINT "mcp_oauth_grants_scopes_valid" CHECK (jsonb_typeof("mcp_oauth_grants"."scopes") = 'array' and jsonb_array_length("mcp_oauth_grants"."scopes") > 0 and "mcp_oauth_grants"."scopes" <@ '["read","write"]'::jsonb)
);
--> statement-breakpoint
ALTER TABLE "oauth_codes" ALTER COLUMN "workspace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ALTER COLUMN "workspace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD COLUMN "grant_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN "grant_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_oauth_grant_workspaces" ADD CONSTRAINT "mcp_oauth_grant_workspaces_grant_id_mcp_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_grant_workspaces" ADD CONSTRAINT "mcp_oauth_grant_workspaces_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_oauth_grant_workspaces_workspace_idx" ON "mcp_oauth_grant_workspaces" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_grants_user_idx" ON "mcp_oauth_grants" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_grant_id_mcp_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_grant_id_mcp_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_grant_idx" ON "oauth_refresh_tokens" USING btree ("grant_id");--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_one_binding" CHECK (num_nonnulls("oauth_codes"."workspace_id", "oauth_codes"."grant_id") = 1);--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_one_binding" CHECK (num_nonnulls("oauth_refresh_tokens"."workspace_id", "oauth_refresh_tokens"."grant_id") = 1);