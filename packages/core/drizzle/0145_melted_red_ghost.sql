DROP TABLE "file_reservations" CASCADE;--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "anthropic_api_key";--> statement-breakpoint
ALTER TABLE "backend_pauses" DROP COLUMN "paused_at";--> statement-breakpoint
ALTER TABLE "external_links" DROP COLUMN "last_pushed_hash";--> statement-breakpoint
ALTER TABLE "path_claims" DROP COLUMN "release_reason";--> statement-breakpoint
ALTER TABLE "releases" DROP COLUMN "strategy";--> statement-breakpoint
ALTER TABLE "releases" DROP COLUMN "source_ref";--> statement-breakpoint
ALTER TABLE "releases" DROP COLUMN "target_ref";