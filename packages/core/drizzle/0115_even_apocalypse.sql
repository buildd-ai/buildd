DROP INDEX "path_claims_active_idx";--> statement-breakpoint
CREATE INDEX "path_claim_waiters_starvation_idx" ON "path_claim_waiters" USING btree ("workspace_id","registered_at") WHERE "path_claim_waiters"."notified_at" IS NULL;--> statement-breakpoint
CREATE INDEX "path_claims_active_idx" ON "path_claims" USING btree ("workspace_id","path") WHERE "path_claims"."released_at" IS NULL;