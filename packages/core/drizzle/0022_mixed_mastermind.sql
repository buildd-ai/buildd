-- Migrate heartbeat config to schedule taskTemplate before dropping columns
UPDATE task_schedules ts
SET task_template = jsonb_set(
  COALESCE(ts.task_template, '{}'::jsonb),
  '{context,heartbeat}',
  to_jsonb(o.is_heartbeat)
)
FROM objectives o
WHERE o.schedule_id = ts.id
AND o.is_heartbeat = true;--> statement-breakpoint

-- Migrate heartbeat checklist to schedule taskTemplate
UPDATE task_schedules ts
SET task_template = jsonb_set(
  ts.task_template,
  '{context,heartbeatChecklist}',
  to_jsonb(o.heartbeat_checklist)
)
FROM objectives o
WHERE o.schedule_id = ts.id
AND o.heartbeat_checklist IS NOT NULL;--> statement-breakpoint

-- Migrate activeHoursStart to schedule taskTemplate
UPDATE task_schedules ts
SET task_template = jsonb_set(
  ts.task_template,
  '{context,activeHoursStart}',
  to_jsonb(o.active_hours_start)
)
FROM objectives o
WHERE o.schedule_id = ts.id
AND o.active_hours_start IS NOT NULL;--> statement-breakpoint

-- Migrate activeHoursEnd to schedule taskTemplate
UPDATE task_schedules ts
SET task_template = jsonb_set(
  ts.task_template,
  '{context,activeHoursEnd}',
  to_jsonb(o.active_hours_end)
)
FROM objectives o
WHERE o.schedule_id = ts.id
AND o.active_hours_end IS NOT NULL;--> statement-breakpoint

-- Migrate activeHoursTimezone to schedule taskTemplate
UPDATE task_schedules ts
SET task_template = jsonb_set(
  ts.task_template,
  '{context,activeHoursTimezone}',
  to_jsonb(o.active_hours_timezone)
)
FROM objectives o
WHERE o.schedule_id = ts.id
AND o.active_hours_timezone IS NOT NULL;--> statement-breakpoint

ALTER TABLE "objectives" DROP COLUMN IF EXISTS "cron_expression";--> statement-breakpoint
ALTER TABLE "objectives" DROP COLUMN IF EXISTS "is_heartbeat";--> statement-breakpoint
ALTER TABLE "objectives" DROP COLUMN IF EXISTS "heartbeat_checklist";--> statement-breakpoint
ALTER TABLE "objectives" DROP COLUMN IF EXISTS "active_hours_start";--> statement-breakpoint
ALTER TABLE "objectives" DROP COLUMN IF EXISTS "active_hours_end";--> statement-breakpoint
ALTER TABLE "objectives" DROP COLUMN IF EXISTS "active_hours_timezone";--> statement-breakpoint
ALTER TABLE "objectives" DROP COLUMN IF EXISTS "default_role_slug";
