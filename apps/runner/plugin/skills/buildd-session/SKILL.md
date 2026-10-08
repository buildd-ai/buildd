---
name: buildd-session
description: "Use in an interactive coding session that has the buildd MCP server, when you are about to pick up, report on, or finish a buildd task from this session: claim_task binds the work to this session, progress/questions/completion go through buildd's own actions, and closing the session releases the slot."
author: buildd
---

# buildd from your own session

This session is visible in buildd as an **interactive session** (presence) as
soon as it starts, through the buildd plugin's hooks. Presence holds no agent
slot and creates no task. Nothing you type or read here is sent: the hooks
report only that the session exists, when it was last active, and which task
it claimed.

The full task workflow (recall → claim → progress → PR → artifact → learn →
complete, blocked-vs-question, friction reports, branch strategy) is the
`buildd-mcp-consumer` skill, also served as the MCP resource
`buildd://workspace/skills`. Read it before your first task action. What is
specific to a session like this one:

1. **Claim explicitly.** `buildd action=claim_task params={ taskId }`. That is
   the only thing that makes this session a tracked worker. The hook sees the
   reply and binds this session to that worker, so the dashboard shows
   "Claude Code · working on <task>" and your activity keeps the claim alive.
   Never claim just to look at a task; use `get_task`.
2. **Report through buildd's actions, not prose.**
   - progress → `update_progress` (also how you receive a message someone sent
     you from buildd; when the hook says one is waiting, call it)
   - a question you can proceed under → `post_note type=question` with
     `defaultChoice`; a genuine hard block → ask the user
   - done → `create_pr` (if there are changes), then `complete_task`
3. **Closing the session is safe.** If the task is finished, its slot is
   released. If it is not, buildd puts the task back in the queue and marks
   the claim released. It never marks unfinished work completed. `/clear` does
   not release a claim.
4. **Without the hooks** (disabled, untrusted in Codex, or a client without
   hooks) everything above still works over MCP alone. Buildd just sees the
   session only once it claims, and keeps the claim alive from your MCP calls.
