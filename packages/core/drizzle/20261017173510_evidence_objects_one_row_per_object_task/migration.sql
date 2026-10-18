-- One evidence_objects row per (object_key, task_id), before the unique index
-- at the end of this file is built. A CI job log capture used to read then write, so two
-- captures of one object that overlapped could each insert a row. Keep the row
-- furthest along (indexed, then queued, then stored), newest first among equals,
-- and delete the rest. Scout rows (task_id NULL) are never duplicates of
-- each other here and are left alone. Re-running deletes nothing.
DELETE FROM "evidence_objects" e
USING (
  SELECT "id", row_number() OVER (
    PARTITION BY "object_key", "task_id"
    ORDER BY ("index_state" = 'indexed') DESC,
             ("index_state" = 'queued') DESC,
             ("upload_state" = 'stored') DESC,
             "updated_at" DESC, "created_at" DESC, "id" DESC
  ) AS rn
  FROM "evidence_objects"
  WHERE "task_id" IS NOT NULL
) ranked
WHERE e."id" = ranked."id" AND ranked.rn > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_objects_object_task_unique" ON "evidence_objects" ("object_key","task_id");