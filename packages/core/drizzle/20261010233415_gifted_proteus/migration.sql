CREATE TABLE "spec_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"spec_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"artifact_revision" integer NOT NULL,
	"content_hash" text NOT NULL,
	"author_kind" text NOT NULL,
	"author_id" text NOT NULL,
	"change_summary" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "specs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"scope" text NOT NULL,
	"parent_spec_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"body_artifact_id" uuid NOT NULL,
	"head_revision" integer DEFAULT 1 NOT NULL,
	"approved_revision" integer,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spec_revisions" ADD CONSTRAINT "spec_revisions_spec_id_specs_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."specs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_body_artifact_id_artifacts_id_fk" FOREIGN KEY ("body_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "spec_revisions_spec_revision_idx" ON "spec_revisions" USING btree ("spec_id","revision");--> statement-breakpoint
CREATE INDEX "specs_workspace_idx" ON "specs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "specs_parent_idx" ON "specs" USING btree ("parent_spec_id");