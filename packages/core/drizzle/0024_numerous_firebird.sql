-- Custom SQL migration file, put you code below! --
ALTER TABLE task_schedules ALTER COLUMN workspace_id DROP NOT NULL;