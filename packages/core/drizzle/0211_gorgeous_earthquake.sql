CREATE TABLE "pr_reverts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repo" text NOT NULL,
	"reverted_by" text NOT NULL,
	"reverted_pr_number" integer,
	"reverted_sha" text,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pr_reverts" ADD CONSTRAINT "pr_reverts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pr_reverts_workspace_dedupe_idx" ON "pr_reverts" USING btree ("workspace_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "pr_reverts_workspace_pr_idx" ON "pr_reverts" USING btree ("workspace_id","reverted_pr_number");