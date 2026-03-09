# Daily Planner (Dispatch)

Use the `dispatch` MCP tool to manage the user's personal daily planner at dispatch.buildd.dev.

## When to use

- User shares guidance, recommendations, or advice that implies a future action (maintenance schedules, health checkups, renewal reminders)
- User asks to schedule, create, or manage personal tasks
- User asks to check their day, calendar, or inbox
- User wants to send themselves a notification

## How to parse guidance into items

When the user pastes AI-generated advice or professional guidance:

1. **Extract the actionable item** — what needs to happen (e.g., "check HVAC filter")
2. **Determine the schedule** — when it should first happen (e.g., "in 3 months")
3. **Store context in notes** — the reasoning, criteria for completion, and next-step logic
4. **Pick the right category**: household, health, errand, work, or life

### Notes template for recurring checks

```
[What]: Brief description of the item/system
[Schedule]: Check every X months, replace/renew at Y months
[Factors]: Why this schedule (environment, usage, etc.)
[Test]: How to evaluate if action is needed
[If OK]: Reschedule check +X months
[If done]: Mark complete, create new check from this date
```

## Key actions

| Action | When to use |
|---|---|
| `create_item` | New task. scheduledTime is optional — omit for date-only items |
| `reschedule` | Defer an item forward. Use `days` (relative) or `date` (absolute). Defaults to 90 days. Resets completedAt. |
| `complete_item` | Mark done |
| `list_items` | See today's plan (or a specific date) |
| `send_digest` | Push a Pushover notification. Supports HTML. |
| `add_to_calendar` | Create a Google Calendar event |
| `list_calendar_events` | View calendar for a date |
| `scan_emails` | Trigger iCloud email scan |
| `list_emails` | Read recently scanned emails |

## Examples

### Maintenance check from AI guidance
```
create_item: {
  title: "Check HVAC filter (Honeywell 5\" pop-up)",
  category: "household",
  scheduledDate: "2026-06-09",
  priority: 4,
  notes: "[What]: Honeywell pop-up media filter, 5-inch, 5-ton system\n[Schedule]: Check every 3 months, replace at 6-9 months\n[Factors]: Georgia — heavy pollen Mar-May, long AC summers\n[Test]: Hold to light — if very little passes through, replace\n[If OK]: Reschedule +3 months\n[If done]: Mark complete, create new 3-month check"
}
```

### Snooze a check that's still OK
```
reschedule: { id: "<item-id>", days: 90 }
```

### Health reminder
```
create_item: {
  title: "Schedule annual physical",
  category: "health",
  scheduledDate: "2026-09-01",
  priority: 5,
  notes: "Last physical: March 2026. Schedule with Dr. [name]."
}
```
