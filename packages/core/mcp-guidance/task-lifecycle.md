---
name: task-lifecycle
description: "Read when you claim, work or finish a buildd task: the claim to progress to PR to complete order, blocked versus question, ask_human from an interactive session, and running a mission locally."
---

# Task lifecycle over MCP

One task, one worker, one branch. The order:

```
recall → claim_task → work → update_progress → create_pr → create_artifact → learn → complete_task
```

`buildd action=X` means: call X on the group tool that lists it, or on the
single `buildd` tool if that is what you have.

## Steps

1. **Recall first:** `recall query="<task title>" scope=["memory","task"]`
   for prior gotchas and how similar tasks went.
2. **Claim:** `buildd action=claim_task` takes the highest-priority pending
   task; `buildd action=claim_task params={ taskId }` takes one named task.
   The reply has your worker id, the branch to check out and the task. A reply
   starting `Nothing claimed:` names the reason (held mission, unmet
   dependency, no free slot, a future start). Read it; do not loop.
3. **Read the whole brief:** `buildd action=get_task params={ taskId, fullDescription: true }`.
   If it names an artifact `key`, read it with `list_artifacts` and
   `get_artifact` before starting. If it is pinned to a Living Spec, read the
   pinned revision (topic `living-specs`).
4. **Work** on the branch `claim_task` gave you.
5. **Progress:** `buildd action=update_progress params={ message }` at each
   milestone. It is your heartbeat: an interactive worker that goes quiet for
   a long stretch is released and its task goes back to pending. The
   `progress` percentage is legacy and never shown.
6. **Ship:** push, then `buildd action=create_pr` (topic `pr-landing`).
7. **Record:** `buildd action=create_artifact params={ type, title, content }`
   with `type: "summary"`, or `type: "impl_plan"` plus a `key` when a later
   task reads it by name. Then `learn` what the next agent should know.
8. **Finish:** `buildd action=complete_task params={ summary }`. With
   `error` instead, the task is marked failed.
   - Scratch commits or edits you will not ship: add `discardEdits` with the
     reason. Never use it to hide unfinished work.
   - The work already landed in someone else's merged PR: add
     `alreadyShippedIn` with that PR number.
   - A completion refused for a missing PR or artifact is a gate: read the 400,
     fix the cause, call again.

## Messages while you work

A runner delivers steering messages into your session. In an interactive
session, call `buildd action=receive_messages` when a hook says messages are
waiting. Each message comes back once.

## Blocked or just unsure

- **Soft question, you can proceed on a default:**
  `buildd action=post_note params={ type: "question", title, body, defaultChoice }`.
  Write the body for someone who has not seen the task: what is being decided,
  one line per option, why you chose the default. Work continues.
- **Hard block in a runner session** (a required tool or credential is
  missing, or the instruction is impossible as written): `AskUserQuestion`.
  The task waits for an answer, is not counted as a failure and is not retried
  into the same wall. Not for design choices you can make yourself.
- **Hard block in your own interactive session** (you called `claim_task`
  yourself): `AskUserQuestion` only reaches whoever is at this keyboard. Use
  `buildd action=ask_human params={ question, options, context }`, then run
  the reply's `waitCommand` as a background shell command. When it exits 0,
  call `buildd action=await_answer params={ waitSeconds: 0 }`. With no
  background commands, loop on `await_answer` (each call waits up to 45 s;
  on `timedOut: true` call again). Do not call `update_progress` while
  parked. Unanswered questions expire (24 h, 4 h in a mission).
- **A tool call came back refused or cancelled:** that refuses one call, not
  the task. Read the reason. Retry a plain cancel once; otherwise take another
  route or skip the step, and still finish with `complete_task`.

## Running a mission's tasks from your own session

Set the mission to `executor: "local"`:
`buildd action=manage_missions params={ action: "update", missionId, executor: "local" }`.
Runners then never auto-claim its tasks. For each one: `claim_task` with its
`taskId`, work, `create_pr`, `complete_task`. Closing the session releases
its worker and an unfinished task goes back to the queue.

Do not use `startMode: "held"` for this. Held is a pause: it blocks your own
claims too.

## Global instructions that name other reporting tools

A user's global CLAUDE.md may say to report status through another tool. In
a buildd worker session, buildd's own actions are the record: progress through
`update_progress`, questions through `post_note`, `AskUserQuestion` or
`ask_human`. A named tool that does not exist in this session is simply
inapplicable; it is not a blocker.
