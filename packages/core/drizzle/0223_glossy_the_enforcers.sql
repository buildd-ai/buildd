CREATE TABLE "surface_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repo_full_name" text NOT NULL,
	"base_ref" text NOT NULL,
	"surface" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"base_sha" text,
	"token" uuid NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "change_intents" ADD COLUMN "base_ref" text;--> statement-breakpoint
ALTER TABLE "surface_reservations" ADD CONSTRAINT "surface_reservations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "surface_reservations_surface_idx" ON "surface_reservations" USING btree ("workspace_id","repo_full_name","base_ref","surface");