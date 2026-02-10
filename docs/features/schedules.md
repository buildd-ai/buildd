# Task Schedules

Create recurring tasks that run on a schedule using cron expressions.

## Overview

Task schedules allow you to automate recurring work without manually creating tasks. Common use cases:

- **Daily reports** - Generate metrics every morning
- **Periodic maintenance** - Run cleanup tasks weekly
- **Monitoring checks** - Test APIs every hour
- **Data syncs** - Pull external data on a schedule

## Creating a Schedule

### Via Dashboard

1. Navigate to your workspace
2. Click **"New Task"** button
3. Toggle **"Recurring"** at the top
4. Enter:
   - **Schedule name** - Descriptive name (e.g., "Daily metrics report")
   - **Cron expression** - When to run (e.g., `0 9 * * *` for 9am daily)
   - **Timezone** - Your timezone (defaults to UTC)
   - **Task template** - The task details (title, description, etc.)
5. Click **"Create Schedule"**

### Quick Create Modal

Press `Cmd+K` (or click + button) to open quick create:

1. Enter task title
2. Click the **🕒 Recurring** button
3. Enter cron expression in the inline input
4. Hit Create Schedule

### Via API

```bash
curl -X POST https://buildd.dev/api/workspaces/{workspace-id}/schedules \
  -H "Authorization: Bearer bld_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Daily metrics report",
    "cronExpression": "0 9 * * *",
    "timezone": "America/Los_Angeles",
    "taskTemplate": {
      "title": "Generate metrics report",
      "description": "Pull metrics from DB and post to Slack",
      "priority": 5
    }
  }'
```

## Cron Expression Syntax

Buildd uses standard cron syntax: `minute hour day month weekday`

| Field | Values | Special |
|-------|--------|---------|
| Minute | 0-59 | `*` (every), `*/5` (every 5) |
| Hour | 0-23 | `*` (every), `*/2` (every 2) |
| Day | 1-31 | `*` (every), `1,15` (1st and 15th) |
| Month | 1-12 | `*` (every), `1-6` (Jan-Jun) |
| Weekday | 0-7 | `*` (every), `1-5` (Mon-Fri), 0=7=Sun |

### Common Examples

```bash
# Every minute
* * * * *

# Every hour at :00
0 * * * *

# Every day at 9am UTC
0 9 * * *

# Every Monday at 8am
0 8 * * 1

# Every weekday (Mon-Fri) at 6pm
0 18 * * 1-5

# Every 15 minutes
*/15 * * * *

# First day of every month at midnight
0 0 1 * *

# Every hour during business hours (9am-5pm)
0 9-17 * * *
```

### Interactive Preview

The dashboard shows the next 3 run times when you enter a cron expression, helping you verify the schedule is correct before creating it.

## Timezone Support

Schedules run in the timezone you specify. For example:

- `0 9 * * *` in `America/Los_Angeles` = 9am PT (12pm ET, 5pm UTC)
- `0 9 * * *` in `UTC` = 9am UTC (1am PT, 4am ET)

**Tip:** Use UTC for consistency across distributed teams, or your local timezone for business-hours schedules.

## Concurrency Control

Limit how many tasks from a schedule can run simultaneously:

```json
{
  "maxConcurrentFromSchedule": 3
}
```

If 3 tasks are already running when the schedule triggers, it will skip creating a new task and advance `nextRunAt` to the next scheduled time.

**Use cases:**
- Prevent resource exhaustion from slow tasks
- Ensure tasks complete before new ones start
- Rate limit external API calls

## Automatic Pause on Failures

Schedules can automatically pause after repeated failures:

```json
{
  "pauseAfterFailures": 5
}
```

After 5 consecutive task failures, the schedule is disabled (`enabled=false`). This prevents runaway errors from creating thousands of failed tasks.

To resume: manually re-enable the schedule in the dashboard after fixing the underlying issue.

## Schedule Management

### View Schedules

```bash
GET /api/workspaces/{workspace-id}/schedules
```

Response:
```json
{
  "schedules": [
    {
      "id": "sched_xxx",
      "name": "Daily metrics report",
      "enabled": true,
      "cronExpression": "0 9 * * *",
      "timezone": "America/Los_Angeles",
      "nextRunAt": "2026-02-09T17:00:00.000Z",
      "lastRunAt": "2026-02-08T17:00:00.000Z",
      "totalRuns": 42,
      "consecutiveFailures": 0,
      "maxConcurrentFromSchedule": 3,
      "pauseAfterFailures": 5
    }
  ]
}
```

### Update Schedule

```bash
PATCH /api/workspaces/{workspace-id}/schedules/{schedule-id}
```

Update any field:
```json
{
  "enabled": false,           // Pause schedule
  "cronExpression": "0 10 * * *",  // Change time
  "taskTemplate": {           // Update task details
    "description": "New description"
  }
}
```

### Delete Schedule

```bash
DELETE /api/workspaces/{workspace-id}/schedules/{schedule-id}
```

This does **not** delete tasks that were already created from this schedule.

## How Schedules are Triggered

Schedules require an **external trigger** that calls the `/api/cron/schedules` endpoint every minute. The endpoint:

1. Finds schedules where `nextRunAt <= now` and `enabled=true`
2. Checks concurrency limits
3. Creates tasks from `taskTemplate`
4. Updates `nextRunAt` to the next scheduled time
5. Dispatches tasks to available workers

### Setup Trigger

See [Self-Hosting Guide](../deployment/self-hosting.md#alternative-cron-trigger-services) for options:

- **Vercel Pro**: Built-in cron via `vercel.json`
- **cron-job.org**: Free external cron service
- **System crontab**: `* * * * * curl -H "Authorization: Bearer SECRET" URL`
- **GitHub Actions**: Scheduled workflow (has 3-10min delay)

**Required environment variable:**
```bash
CRON_SECRET=<generate-with-openssl-rand-base64-32>
```

The cron endpoint requires this secret via `Authorization: Bearer` header to prevent unauthorized access.

## Monitoring

### Check Schedule Status

View in dashboard:
- **Next run**: When the schedule will trigger next
- **Last run**: When it last created a task
- **Total runs**: How many tasks created total
- **Failures**: Consecutive failures (resets on success)

### View Tasks from Schedule

Tasks created from schedules have:
```json
{
  "creationSource": "schedule",
  "context": {
    "scheduleId": "sched_xxx",
    "scheduleName": "Daily metrics report"
  }
}
```

Filter tasks by schedule:
```bash
GET /api/tasks?workspace={id}&creationSource=schedule
```

### Cron Trigger Logs

The `/api/cron/schedules` endpoint returns stats:
```json
{
  "processed": 5,    // Schedules checked this run
  "created": 3,      // Tasks created
  "skipped": 2,      // Skipped (concurrency limit or already processed)
  "errors": 0        // Failures
}
```

Monitor these stats to ensure schedules are running correctly.

## Troubleshooting

### Schedule not triggering

**Check nextRunAt:**
```sql
SELECT id, name, enabled, next_run_at, last_run_at
FROM task_schedules
WHERE enabled = true;
```

If `next_run_at` is in the past but no tasks created:
1. Verify cron trigger is running: check endpoint logs
2. Check `CRON_SECRET` is set correctly
3. Ensure endpoint is reachable: `curl -H "Authorization: Bearer SECRET" URL`

**Check concurrency limit:**

If `maxConcurrentFromSchedule > 0`, check active tasks:
```sql
SELECT COUNT(*)
FROM tasks
WHERE workspace_id = 'xxx'
  AND status IN ('pending', 'assigned', 'in_progress')
  AND context->>'scheduleId' = 'sched_xxx';
```

If count >= `maxConcurrentFromSchedule`, schedule will skip until tasks complete.

### Schedule paused unexpectedly

Check `consecutiveFailures`:
```sql
SELECT id, name, consecutive_failures, pause_after_failures, last_error
FROM task_schedules
WHERE id = 'sched_xxx';
```

If `consecutive_failures >= pause_after_failures`, schedule auto-paused. Fix the underlying issue, then re-enable:

```bash
PATCH /api/workspaces/{workspace-id}/schedules/{schedule-id}
{
  "enabled": true,
  "consecutiveFailures": 0  // Reset counter
}
```

### Wrong timezone

Verify timezone is valid:
```bash
# Valid: America/Los_Angeles, Europe/London, UTC
# Invalid: PST, PDT, EST (abbreviations not supported)
```

Use IANA timezone database names. Common values:
- `UTC` - Universal time
- `America/New_York` - Eastern (handles DST)
- `America/Los_Angeles` - Pacific (handles DST)
- `Europe/London` - GMT/BST (handles DST)
- `Asia/Tokyo` - Japan Standard Time

### Cron expression not working

Test expressions at [crontab.guru](https://crontab.guru) or use the dashboard preview (shows next 3 run times).

Common mistakes:
- `0 0 * * 0` = Sundays, not "every day" (use `0 0 * * *`)
- `*/60 * * * *` = Invalid (minutes only go to 59, use `0 * * * *` for hourly)
- `0 24 * * *` = Invalid (hours are 0-23, use `0 0 * * *` for midnight)

## Best Practices

1. **Start with UTC** - Simplest for distributed teams, convert to local time later if needed
2. **Test first** - Create a one-time task before scheduling recurring
3. **Set concurrency limits** - Prevent resource exhaustion from slow tasks
4. **Enable auto-pause** - Use `pauseAfterFailures` to catch persistent issues
5. **Monitor regularly** - Check `consecutiveFailures` and `nextRunAt` weekly
6. **Use descriptive names** - "Daily ETL job" not "Schedule 1"
7. **Add context** - Include schedule details in task description for debugging

## API Reference

### Create Schedule

```http
POST /api/workspaces/{workspace-id}/schedules
Content-Type: application/json
Authorization: Bearer bld_xxx

{
  "name": string,                    // Display name
  "cronExpression": string,          // Cron syntax
  "timezone": string,                // IANA timezone
  "enabled": boolean?,               // Default true
  "maxConcurrentFromSchedule": number?, // Default 0 (unlimited)
  "pauseAfterFailures": number?,     // Default 0 (never pause)
  "taskTemplate": {
    "title": string,
    "description": string?,
    "priority": number?,             // 0-10, default 0
    "mode": "execution"|"planning"?, // Default "execution"
    "context": object?               // Additional metadata
  }
}
```

### List Schedules

```http
GET /api/workspaces/{workspace-id}/schedules
Authorization: Bearer bld_xxx
```

### Update Schedule

```http
PATCH /api/workspaces/{workspace-id}/schedules/{schedule-id}
Content-Type: application/json
Authorization: Bearer bld_xxx

{
  "enabled": boolean?,
  "cronExpression": string?,
  "timezone": string?,
  "maxConcurrentFromSchedule": number?,
  "pauseAfterFailures": number?,
  "taskTemplate": object?  // Partial update supported
}
```

### Delete Schedule

```http
DELETE /api/workspaces/{workspace-id}/schedules/{schedule-id}
Authorization: Bearer bld_xxx
```

### Trigger Schedules (Internal)

```http
GET /api/cron/schedules
Authorization: Bearer <CRON_SECRET>
```

This endpoint should only be called by your cron trigger, not by users.

## Next Steps

- [Set up cron trigger](../deployment/self-hosting.md#alternative-cron-trigger-services)
- [API documentation](../api/endpoints.md)
- [Self-hosting guide](../deployment/self-hosting.md)
