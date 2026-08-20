ALTER TABLE "tasks" ADD COLUMN "task_class" text DEFAULT 'work' NOT NULL;--> statement-breakpoint

-- Backfill: existing rows receive 'work' from the column default above.
-- Overwrite rows that should be 'attempt' or 'bookkeeping'.

-- Pass 1: attempt — title-prefix match (CI Retry, Conflict Retry, reviewer) OR
-- (has parentTaskId AND mode != 'execution') for legacy unlabelled retries.
UPDATE tasks SET task_class = 'attempt'
WHERE task_class = 'work'
  AND (
    title ~* '^\[(CI )?[Rr]etry'
    OR title ~* '^\[Conflict Retry'
    OR title ~* '^\[reviewer'
    OR (parent_task_id IS NOT NULL AND mode IS DISTINCT FROM 'execution')
  );--> statement-breakpoint

-- Pass 2: bookkeeping — planning-mode, known coordination titles, friction, coordination kind.
-- Only touches rows still 'work' (attempt rows are already set and must not be overwritten).
UPDATE tasks SET task_class = 'bookkeeping'
WHERE task_class = 'work'
  AND (
    mode = 'planning'
    OR title LIKE 'Aggregate results:%'
    OR title LIKE 'Evaluate mission completion:%'
    OR title LIKE 'Mission:%'
    OR title LIKE 'Close mission%'
    OR title ~* '^\[friction\]'
    OR kind = 'coordination'
  );--> statement-breakpoint

CREATE INDEX "tasks_task_class_idx" ON "tasks" USING btree ("task_class");
