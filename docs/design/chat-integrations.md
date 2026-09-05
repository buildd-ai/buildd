---
title: Chat integrations (Slack, Discord)
status: Retired — record of a removed implementation
owner: max
---

# Chat integrations

Slack and Discord slash-command integrations were built, never used, and removed.
This note records what was learned so a rebuild starts from it rather than from
scratch. It is a design note, not a contract — nothing asserts that any of this
is currently implemented.

## Why they were removed

Neither `SLACK_SIGNING_SECRET` nor `DISCORD_PUBLIC_KEY` was ever set in
production, so both endpoints rejected every request for their whole lifetime.
No workspace ever carried a `discord_config` or `slack_config` value. Meanwhile
both carried real upkeep: two public endpoints, two config columns, two docs
pages, and no tests.

They were also redundant. "Create a task from a chat message" is one job, and
the MCP server already does it better from the place agents actually run.

## What a rebuild should keep

Only two things in the old implementation were non-obvious.

**Signature verification.** Both platforms sign requests and both have a
sequencing trap:

- **Slack** — HMAC-SHA256 over the literal string `v0:{timestamp}:{rawBody}`,
  compared against `x-slack-signature`, with `x-slack-request-timestamp` rejected
  beyond a 5-minute skew. The trap: Slack's one-time `url_verification` challenge
  must be answered *before* the signature gate, or the app can never be
  installed. Reading the raw body before any JSON parsing is required, since the
  signature covers bytes.
- **Discord** — Ed25519 over `timestamp + rawBody` against
  `x-signature-ed25519`. The trap: Discord sends a `PING` interaction on save and
  expects a `PONG`; miss it and the endpoint is marked invalid.

**Workspace resolution.** An inbound message carries the *platform's* team or
guild id, not a buildd workspace id, so the handler has to map one to the other.
The old implementation did this with a full table scan filtered in JS. A rebuild
wants an indexed column on `workspaces`, or a dedicated mapping table.

## What the old implementation got wrong

Worth not repeating:

- **Bot tokens lived in a `jsonb` column on `workspaces`, in plaintext.** That
  contradicts the credentials architecture — agent-backend and integration
  credentials belong in the `secrets` table with team/account/workspace scoping
  and encryption at rest. A rebuild should add a `purpose` there instead of a new
  column.
- **No tenancy check on the interaction callback.** Discord's `approve_plan`
  button handler took a task id straight out of the interaction's `custom_id`
  and updated that task, never re-reading `guild_id` or comparing it to the
  task's workspace. Any inbound callback must re-derive the workspace from the
  platform id and verify the target belongs to it.
- **Thread capture could never fire.** The Slack event handler matched replies
  to a task by a thread timestamp in task context, but the slash-command handler
  never wrote one. The feature was documented as working for months.
- **Two of three documented Discord behaviours did not exist.** The Approve
  button was never emitted (notifications carried no `components`), and the
  callback that would have handled it only flipped the task's mode rather than
  creating child tasks the way `POST /api/tasks/[id]/approve-plan` does.
- **The published scope list was incomplete.** Slack thread events need Event
  Subscriptions plus `channels:history` / `groups:history`, none of which the
  setup guide mentioned — so following the docs could not have produced the
  documented behaviour even if the code had worked.

## If you rebuild

Start from one platform, not both. Ship it behind a real credential in the
`secrets` table, with a tenancy check on every inbound callback and a test that
proves an unsigned request is rejected. Write the docs page from the working
code rather than from the plan.

The removed implementation is recoverable from history:
`git log --diff-filter=D -- 'apps/web/src/app/api/integrations/**'`.
