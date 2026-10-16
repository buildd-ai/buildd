ALTER TABLE "artifacts" ADD COLUMN "upload_state" text;--> statement-breakpoint
CREATE INDEX "artifacts_upload_pending_idx" ON "artifacts" USING btree ("created_at") WHERE upload_state = 'pending';