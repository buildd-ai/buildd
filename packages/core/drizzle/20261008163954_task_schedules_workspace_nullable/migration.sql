-- Released databases already allow NULL here (a team-level mission's check-in
-- schedule has no workspace); the squashed baseline created the column NOT NULL,
-- so fresh databases rejected those schedules. No-op where it is already nullable.
ALTER TABLE "task_schedules" ALTER COLUMN "workspace_id" DROP NOT NULL;
