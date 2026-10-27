CREATE TABLE "passkey_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"binding" text NOT NULL,
	"challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_passkeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" text[],
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "spec_passkey_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "passkey_challenges_challenge_idx" ON "passkey_challenges" ("challenge");--> statement-breakpoint
CREATE INDEX "passkey_challenges_user_id_idx" ON "passkey_challenges" ("user_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_passkeys_credential_id_idx" ON "user_passkeys" ("credential_id");--> statement-breakpoint
CREATE INDEX "user_passkeys_user_id_idx" ON "user_passkeys" ("user_id");--> statement-breakpoint
ALTER TABLE "passkey_challenges" ADD CONSTRAINT "passkey_challenges_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_passkeys" ADD CONSTRAINT "user_passkeys_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;