---
name: diagnosis
description: "Read when a task, mission or PR is stuck or failed, or before you file a friction task: explain, error traces, stored evidence, failure analytics and friction dedupe."
---

# Diagnosing failures and reporting friction over MCP

Read the evidence before you guess. Every action here is read-only except
`create_task`.

## Why is this stuck or failed?

1. **State and cause:** `buildd action=explain params={ taskId }` (or
   `missionId`, `prNumber`, `workspaceId`; exactly one subject). It returns the
   state, what it is waiting on, an ordered causal chain with hard references,
   and a next action. Workspace scope lists only the subjects that are waiting
   on something.
2. **Prior knowledge:** `recall query="<error text>" scope=["memory","task"]`.
   Someone may have hit it already.
3. **What the agent ran:** `buildd action=get_error_traces params={ taskId }`
   lists every failing shell command (redacted command, exit code, output tail)
   and the evidence record written when the task ended. With
   `workspaceId` instead it rolls up by pattern, which tells a new failure
   from a recurring one.
4. **The full output:** `buildd action=read_evidence params={ taskId }` lists
   stored evidence (command output, test reports, CI job logs, transcripts,
   PR diffs); add `tail` or `grep` to read the newest match. Output is
   redacted and capped; a truncated read returns a `cursor`.
5. **Red CI on a PR:** `buildd action=get_pr params={ prNumber, includeCiFailures: true }`.
6. **A pending task that never starts:** `explain` on it names the gate;
   `buildd action=get_task params={ taskId, include: ["dispatch"] }` shows
   each wake that was sent and whether it arrived.

Do not conclude "nothing ran" from an empty list without checking that the
read reached the data: a `forbidden` or 401 is not an empty result.

## Is it new?

- `buildd action=get_failure_analytics params={ error }` with your error text:
  whether it is a known pattern, its count, first and last seen, and a
  `frictionSignature` to reuse.
- `errorPrefix` rolls up a family whose tail varies (for example
  `needs_input:`). `family: "gate"` lists server refusals and bypasses instead
  of worker failures.
- `buildd action=list_incidents` shows systemic patterns already being
  tracked.

## Report friction

When a platform action errors unexpectedly, a tool limit forces a detour, or
something costs real time through confusion, file it instead of working
around it silently:

`buildd action=create_task params={ title, description, priority, kind, context }`

- `title`: `[friction] <short description>`. `description`: what broke, what
  you expected, what you did instead. Low priority is fine.
- `context: { frictionSignature, frictionExcerpt }`. Take the signature from
  `get_failure_analytics` for a worker failure, from `get_error_traces` for a
  traced tool error, or straight off the 400 body for a gate refusal (a
  refused `create_task` or completion carries one). Forward it as given.
- An open friction task with the same signature in the workspace gets your
  report appended, and you get its id back. That is expected.
