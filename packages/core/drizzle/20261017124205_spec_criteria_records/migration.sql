CREATE TABLE "spec_criteria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"spec_id" uuid NOT NULL,
	"spec_revision_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"criterion_id" text NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"text_hash" text NOT NULL,
	"section" text NOT NULL,
	"checks" jsonb DEFAULT '[]' NOT NULL,
	"screens" jsonb DEFAULT '[]' NOT NULL,
	"replaces" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spec_revision_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"spec_id" uuid NOT NULL,
	"from_revision" integer NOT NULL,
	"to_revision" integer NOT NULL,
	"algo" integer NOT NULL,
	"review" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spec_outcome_verdicts" ADD COLUMN "criterion_text_hash" text;--> statement-breakpoint
ALTER TABLE "spec_revisions" ADD COLUMN "criteria_count" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "spec_criteria_revision_criterion_idx" ON "spec_criteria" ("spec_revision_id","criterion_id");--> statement-breakpoint
CREATE INDEX "spec_criteria_spec_criterion_idx" ON "spec_criteria" ("spec_id","criterion_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "spec_revision_reviews_pair_idx" ON "spec_revision_reviews" ("spec_id","from_revision","to_revision","algo");--> statement-breakpoint
ALTER TABLE "spec_criteria" ADD CONSTRAINT "spec_criteria_spec_id_specs_id_fkey" FOREIGN KEY ("spec_id") REFERENCES "specs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spec_criteria" ADD CONSTRAINT "spec_criteria_spec_revision_id_spec_revisions_id_fkey" FOREIGN KEY ("spec_revision_id") REFERENCES "spec_revisions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spec_revision_reviews" ADD CONSTRAINT "spec_revision_reviews_spec_id_specs_id_fkey" FOREIGN KEY ("spec_id") REFERENCES "specs"("id") ON DELETE CASCADE;