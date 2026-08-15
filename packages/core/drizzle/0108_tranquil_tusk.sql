CREATE TABLE "dark_check_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"check_name" text NOT NULL,
	"consecutive_skips" integer DEFAULT 0 NOT NULL,
	"last_alerted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dark_check_alerts" ADD CONSTRAINT "dark_check_alerts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dark_check_alerts_ws_check_idx" ON "dark_check_alerts" USING btree ("workspace_id","check_name");