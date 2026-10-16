CREATE TABLE "widgets" (
	"id" integer PRIMARY KEY,
	"name" text NOT NULL,
	"kind" text
);
--> statement-breakpoint
CREATE INDEX "widgets_kind_idx" ON "widgets" ("kind") WHERE "kind" is not null;