CREATE UNIQUE INDEX IF NOT EXISTS "tasks_active_planning_per_mission" ON "tasks" ("mission_id") WHERE mode = 'planning' AND status IN ('pending', 'assigned', 'in_progress');
