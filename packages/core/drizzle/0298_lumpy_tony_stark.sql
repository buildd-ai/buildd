CREATE TABLE "artifact_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"artifact_revision" integer,
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"team_id" uuid NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_links_normative_is_pinned" CHECK ("artifact_links"."relation" <> 'normative_reference' OR "artifact_links"."artifact_revision" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "artifact_links" ADD CONSTRAINT "artifact_links_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_links_unique_idx" ON "artifact_links" USING btree ("artifact_id","subject_kind","subject_id","relation");--> statement-breakpoint
CREATE INDEX "artifact_links_subject_idx" ON "artifact_links" USING btree ("subject_kind","subject_id");