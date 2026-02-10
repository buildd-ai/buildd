-- Phase 1: Create teams and team_members tables
CREATE TABLE IF NOT EXISTS "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "teams_slug_idx" ON "teams" ("slug");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "team_members" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_members_team_id_user_id_pk" PRIMARY KEY("team_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_members_team_idx" ON "team_members" ("team_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_members_user_idx" ON "team_members" ("user_id");
--> statement-breakpoint

-- Phase 2: Add team_id columns (nullable first for migration)
ALTER TABLE "workspaces" ADD COLUMN "team_id" uuid;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "team_id" uuid;
--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "team_id" uuid;
--> statement-breakpoint

-- Phase 3: Data migration - create personal teams for each existing user
INSERT INTO "teams" ("id", "name", "slug", "created_at", "updated_at")
SELECT
  gen_random_uuid(),
  COALESCE(u."name", u."email") || '''s Team',
  'personal-' || u."id",
  NOW(),
  NOW()
FROM "users" u;
--> statement-breakpoint

-- Insert team_members entries (owner role)
INSERT INTO "team_members" ("team_id", "user_id", "role", "joined_at")
SELECT t."id", u."id", 'owner', NOW()
FROM "users" u
JOIN "teams" t ON t."slug" = 'personal-' || u."id";
--> statement-breakpoint

-- Migrate workspaces: set team_id from owner_id
UPDATE "workspaces" w
SET "team_id" = t."id"
FROM "teams" t
WHERE t."slug" = 'personal-' || w."owner_id"
  AND w."owner_id" IS NOT NULL;
--> statement-breakpoint

-- Migrate accounts: set team_id from owner_id
UPDATE "accounts" a
SET "team_id" = t."id"
FROM "teams" t
WHERE t."slug" = 'personal-' || a."owner_id"
  AND a."owner_id" IS NOT NULL;
--> statement-breakpoint

-- Migrate skills: set team_id from owner_id
UPDATE "skills" s
SET "team_id" = t."id"
FROM "teams" t
WHERE t."slug" = 'personal-' || s."owner_id";
--> statement-breakpoint

-- Handle orphaned workspaces (null owner_id) - assign to first user's team or create fallback
-- Skip if none exist (most installations won't have this)
UPDATE "workspaces" w
SET "team_id" = (SELECT "id" FROM "teams" LIMIT 1)
WHERE w."team_id" IS NULL
  AND EXISTS (SELECT 1 FROM "teams" LIMIT 1);
--> statement-breakpoint

-- Handle orphaned accounts (null owner_id)
UPDATE "accounts" a
SET "team_id" = (SELECT "id" FROM "teams" LIMIT 1)
WHERE a."team_id" IS NULL
  AND EXISTS (SELECT 1 FROM "teams" LIMIT 1);
--> statement-breakpoint

-- Phase 4: Make team_id NOT NULL and add FKs
ALTER TABLE "workspaces" ALTER COLUMN "team_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "team_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "skills" ALTER COLUMN "team_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- Phase 5: Drop old owner_id columns and indexes
DROP INDEX IF EXISTS "workspaces_owner_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "accounts_owner_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "skills_owner_slug_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "skills_owner_idx";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "owner_id";
--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN IF EXISTS "owner_id";
--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN IF EXISTS "owner_id";
--> statement-breakpoint

-- Phase 6: Add new indexes
CREATE INDEX IF NOT EXISTS "workspaces_team_idx" ON "workspaces" ("team_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounts_team_idx" ON "accounts" ("team_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skills_team_slug_idx" ON "skills" ("team_id", "slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skills_team_idx" ON "skills" ("team_id");
