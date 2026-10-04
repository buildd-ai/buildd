CREATE TABLE "prompts" (
	"id" text NOT NULL,
	"version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"body" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompts_id_version_pk" PRIMARY KEY("id","version")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "prompts_one_active_per_id" ON "prompts" USING btree ("id") WHERE "prompts"."active";