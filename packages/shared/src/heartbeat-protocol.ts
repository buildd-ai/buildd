/**
 * Static mission-heartbeat protocol text — byte-identical across every
 * heartbeat cycle, every cause, and every mission (no interpolation).
 *
 * Rendered by the runner (`apps/runner/src/prompt-builder.ts`) for any task
 * carrying `context.heartbeat === true`, regardless of `roleSlug` — a
 * heartbeat task's role can be swapped away from `organizer` by mission-run's
 * dominant-role derivation, so this must not depend on which role config (if
 * any) got attached at claim time. Previously this text was re-rendered into
 * `tasks.description` on every single heartbeat tick by `buildHeartbeatContext`
 * (`apps/web/src/lib/mission-context.ts`); moving it here means it is no
 * longer duplicated into the DB row (and the knowledge-base index) on every
 * cycle, while the agent still sees identical instructions.
 */
export const HEARTBEAT_PROTOCOL_BLOCK = `\n## Protocol
You are running a mission heartbeat. Your job is to **drive the mission forward**, not just report status.
- Assess the phase above and execute the required actions.
- If you created tasks, retried failures, or made changes, report status "action_taken" with what you did.
- Only report "ok" if the mission is actively progressing and no action is needed RIGHT NOW.
- If the mission is stalled (same state as prior heartbeats), you MUST take action or escalate — never report "ok" for a stalled mission.
- If you need a human decision (e.g., repo creation approval), create a task with a clear question or use waiting_input.
- Before creating a task, check the "Active/Pending Tasks" section. If a pending task with a similar title already exists, do NOT create a duplicate.
- **Prior-work gate**: Before creating any task, check the "Related Prior Work" section provided elsewhere in this task's context. If a retrieved item scores ≥0.82 similarity AND its PR was merged within 14 days, do NOT create the task. Instead: \`post_note type=decision\` naming the PR and why decomposition was skipped for that item.

## Direct Action
If the required work is small (< 5 tool calls) and you have the right tools available, do it yourself instead of creating a task. Examples:
- Classify a few transactions → call the relevant MCP tool directly
- Send a notification → use the notification tool
- Check a status and report → read the data, summarize

Only create child tasks when the work requires:
- A separate git branch / PR
- Extended multi-file code changes
- A different role's expertise (e.g., builder for code)
- More than ~5 minutes of work`;
