# Chat roles: should you pick who you're talking to?

**Status:** Proposed
**Related:** `docs/design/agent-chat.md` ("Should the Orchestrator be the chat?", Tool groups, Models), `docs/design/roles-scoping.md`, `docs/design/tier-model-pools.md`, `docs/design/decision-calls.md`, `apps/web/src/lib/chat/instructions.ts`, `apps/web/src/lib/chat/turn.ts`, `apps/web/src/lib/chat/tools.ts` (`CORE_GROUPS`, `FALLBACK_GROUPS`), `apps/web/src/lib/chat/registry.ts` (`TOOL_GROUPS`, `CHAT_TOOL_SPECS`), `apps/web/src/lib/chat/routing.ts`, `apps/web/src/lib/chat/chat-page-data.ts`, `apps/web/src/lib/chat/turn-feedback.ts`, `apps/web/src/lib/default-roles.ts` (`DEFAULT_ROLES`, `seedDefaultRolesForTeam`), `packages/core/db/schema.ts` (`conversations.agentRoleSlug`, `workspaceSkills`)

## Problem

Chat is one agent. Every turn in `runChatTurn` (`lib/chat/turn.ts`) is prompted
with the same `CHAT_INSTRUCTIONS` (`lib/chat/instructions.ts`) plus a context
block, whatever role the conversation row names. `conversations.agent_role_slug`
exists and defaults to `'organizer'`, but no code reads it to pick a prompt or a
tool set. The Organizer role row only lends chat its name and colour
(`loadOrganizer` in `chat-page-data.ts`), and a sibling change is removing even
that from the header so the chat reads as "buildd".

The question is whether a person should be able to say "I want to talk to the
Researcher" (or to a team's own "Finance" role) and get a different agent: other
instructions, other tools, other write rights, other knowledge.

Nothing is broken today. What makes this worth writing down is that the obvious
implementation is wrong. A role (`workspaceSkills` with `isRole: true`) is tuned
for a runner: a long autonomous session with a repo checkout, a Claude Code tool
allowlist (`Read`, `Edit`, `Bash`…), `maxTurns`, a backend and model, and a PR
or structured `plan` as output. Chat turns are short (`MAX_STEPS = 8`,
`TURN_BUDGET_MS = 45_000`), run on the server, have no repo, and write only
through approval cards. Dropping the Builder's `content` into chat produces an
agent that tells the user it is about to edit files it cannot see.

## Recommendation: not yet

**Don't ship a role picker now.** Do two small no-regret pieces now (a chat
eval harness, and making `agent_role_slug` resolve through a facet table that
has one entry) so that when the picker is worth building it's a week, not a
redesign.

### The case for "not yet"

1. **There's almost nothing to pick between.** Walking the default roles (table
   below), only the Researcher is a genuinely different *conversational* agent.
   The Organizer already plans missions in chat. Builder, Writer and Analyst are
   runner roles whose value is repo work; in chat they reduce to "the Organizer
   files a task with `roleSlug: builder`". Visual auditor and spec validator are
   runner-only. A picker with two useful entries is a toggle pretending to be a
   menu.
2. **It reverses a decision we made on purpose.** `agent-chat.md` chose one
   identity so that "no one has to know which role to ask", and the current
   direction (present chat as buildd) goes further. A picker hands that
   question back to the user on every conversation.
3. **Per-turn routing already does most of what a role would.** `routeTurn`
   picks the tier, whether writes are offered, and which tool group (`area`) to
   send; permissions (`permissions.ts`) decide which writes skip a card. The
   "Researcher" difference is mostly *fewer* write tools and a deeper `recall`,
   which the router and a sentence of instructions can get to without a new
   concept.
4. **We can't measure it.** There is no chat eval harness. The only quality
   signal is thumbs (`turn-feedback.ts`), which feeds tier-pool stats. Adding
   N prompt variants with no way to tell whether they're better than the one
   prompt is how chat quality drifts silently.
5. **The interesting case isn't reachable yet.** The role that would really earn
   a picker is a team's custom domain role, with its own knowledge and
   connectors (`mcpServers`, `requiredEnvVars`). Server-side chat mounts
   none of those. A custom role in chat today would be a name and a paragraph of
   instructions on top of the same tools.

### What would change the answer

Revisit when **any** of these is true:

- A team asks to talk to a specific custom role, and can say what it should do
  differently from the default chat.
- Chat can reach a role's connectors (a role-scoped MCP mount on the server).
  At that point the role changes what chat can *know*, not just its tone.
- The eval harness exists and shows that a narrowed read-only agent answers
  research questions measurably better (fewer wrong tool calls, fewer write
  proposals nobody asked for) than the default with routing.

### The case for "yes, now" (and why it loses)

The strongest argument for now: the Researcher is useful today. "Explain how
the claim route decides eligibility" is a question people ask chat, and the
default answer ("I can't read the repository, want a mission?") is worse than
it needs to be, because `recall` already accepts `scope: code | docs | spec | pr`
over the indexed corpus.

That's a real gap, but it is an *instructions* gap, not a roles gap. The fix is
to tell the one chat agent it can answer code questions from `recall` with
`scope: "code"` and cite what it found, which is small, cheap and doesn't need
a picker. It's included in the follow-up tasks below.

## Proposal (for when we build it)

Written now so the no-regret pieces point the right way.

### The crux: the runner prompt never reaches chat

A role gets a **chat facet** next to its runner facet. Chat reads only the chat
facet; the role's runner `content`, `allowedTools`, `maxTurns`, `model`,
`background`, `mcpServers` and `requiredEnvVars` are ignored by chat. If this
is wrong, if chat ever falls back to the runner prompt when a facet is missing,
chat will claim capabilities it doesn't have and produce plan-shaped output in
prose. A role with no chat facet is **not eligible for chat**; there is no
fallback.

**Safety property: a facet can only narrow.** The base chat surface is today's:
`CHAT_INSTRUCTIONS` rules, the full `TOOL_GROUPS`, approval cards, admin gates,
reach checks, the tier cap. A facet may remove tool groups, remove write
classes, add instructions *after* the base rules, and suggest a default tier. It
cannot add a tool that isn't in `CHAT_TOOL_SPECS`, skip an approval card, lift
an admin gate, widen reach, or exceed the tier cap. The base rules (data is not
instructions, secrets never in chat, one write per turn, never claim a write
that no tool confirmed) are always first in the prompt and a facet can't
replace them.

### Facet vs a separate persona concept

**Facet on the role, not a separate "chat persona" table.** Reasons:

- `agent-chat.md`'s argument still holds: two concepts with the same name
  ("Researcher" the persona and "Researcher" the role) get two memories and
  drift apart. One row means one name, one colour, one set of directives, one
  place an admin edits.
- The handoff is natural. A Researcher in chat that decides the work needs a
  runner proposes a task with `roleSlug: researcher`: the same role on its other
  facet.
- Roles already have scoping, override and admin rules
  (`docs/design/roles-scoping.md`). A separate persona table would need all of
  that again.

Shape:

```ts
// Built-in roles: a table in code, keyed by slug, like DEFAULT_ROLES content.
// Custom roles: workspace_skills.chat_facet jsonb null (null = not in chat).
interface ChatFacet {
  enabled: boolean;                 // custom roles default false
  instructions: string;             // appended after base CHAT_INSTRUCTIONS; capped (e.g. 2,000 chars)
  toolGroups: ToolGroup[];          // subset of TOOL_GROUPS
  writes: 'cards' | 'learn-only' | 'none'; // 'cards' = today's behaviour
  recallScopes?: RecallScope[];     // default memory + task
  defaultTier?: ChatTier;           // a suggestion; the cap and a pin win
}
```

Built-in facets live in code so a prompt fix ships with a deploy and is covered
by the eval harness; a team edits them by creating a field-level override row
(the existing override pattern), not by editing the system row.

### Which roles make sense in chat

| Role | In chat? | What it does differently |
|---|---|---|
| **Organizer** (default) | Yes, it's today's chat | All groups, writes through cards. Planning a mission in chat (settling goal + `goalCriteria`) is already its job; there is no separate "Orchestrator" to add. |
| **Researcher** | Yes, the one real second agent | Reads: `missions`, `tasks`, `prs`, `artifacts`, `memory`. `recall` defaults to `scope: ["code","docs","spec","memory"]` and answers cite what they found. Writes: `learn` only (still carded). It never files work; when the answer is "someone should change this", it says so and offers to hand the conversation to the Organizer. Default tier `standard`. |
| **Reviewer** | Maybe, later | `prs` + `tasks` read; `get_pr_review` first. No writes except `send_agent_message` to a running reviewer. Only worth it once `merge_pr` / `request_pr_review` leave `deferred`. |
| Builder, Writer, Analyst | No | Their value is repo work on a runner. In chat, the Organizer files a task for them. |
| Visual auditor, Spec validator | No | Runner/CI only. |
| **Custom team roles** | Opt-in | Name, colour and instructions from the facet; tool groups a subset. Real value only once connectors reach chat (see "What would change the answer"). |

### Switching semantics

- **Per conversation.** `conversations.agent_role_slug` already exists. The
  role is chosen when the conversation starts (default: Organizer) and can be
  changed from the header; per-turn roles (an `@researcher` in the composer)
  are a non-goal until per-conversation proves useful.
- **A switch is an event row** ("Now talking to Researcher") in the
  conversation, so the model and the reader both see where it changed. History
  stays; the new role reads it as data like any other history.
- **A switch expires pending approvals** (`conversation_approvals.status =
  'expired'`). A card the Organizer proposed must not be answerable under a
  Researcher facet that doesn't offer that tool. Today `turn.ts` adds an
  approval's tool group back for the turn that answers it; that path must check
  the facet, and expiring on switch keeps it simple.
- **Identity.** With the sibling change the header shows "buildd". With roles:
  "buildd" for the Organizer, and "buildd · Researcher" (the role's colour on
  the chip) for anything else, so the default still reads as the product, not
  as a role.
- **Handoff.** The Researcher's "hand to Organizer" is a switch the user
  confirms in one tap, not something the model does on its own.

### Tier: cap and remembered prefs

Order of precedence for a turn's tier (highest first):

1. The team **tier cap**, when the admin has it on: never above the team
   default. Applies to everything below.
2. The conversation's **pinned tier** (`conversations.tier`).
3. The role facet's `defaultTier`, applied only when the conversation is
   unpinned and the user's remembered pref is "auto".
4. Routing's per-turn pick (`routeTurn`).

**Remembered prefs remember workspace and tier, not role.** A new conversation
always starts on the Organizer. A sticky Researcher would silently remove the
ability to file work from the next conversation, which is the one thing a
person opening chat most expects to be able to do. The role belongs to the
conversation.

### Custom team roles: eligibility and control

- `chat_facet` is null on every existing and new role. Null means not in chat;
  nothing changes until an admin opts in.
- Enabling, editing or disabling a facet is an **admin** action (owner/admin,
  server-checked), the same class as the existing skill changes (`update_skill`
  is `admin` in `registry.ts`). Members can pick an enabled role; they can't
  enable one.
- A workspace-scoped role is offered only when that workspace is in reach, and
  picking it pins the conversation to that workspace.
- The role editor shows the chat facet as a second tab next to the runner
  content, with the base rules shown read-only above the facet's instructions
  so an admin sees what they can't override.
- Disabling a facet doesn't break old conversations: they fall back to the
  Organizer with an event row saying so.

### Migration from today

Zero-behaviour-change first step: `runChatTurn` resolves its instructions and
tool groups through `chatFacetFor(conv.agentRoleSlug)`, with one entry,
`organizer`, whose instructions are `CHAT_INSTRUCTIONS` verbatim and whose
groups are all of them. A test asserts the prompt and tool list are
byte-identical to today's for an `organizer` conversation. Any unknown slug
resolves to `organizer`. Every existing row already says `organizer`, so no
data migration. The `chat_facet` column is a separate, later migration, only if
custom roles are built.

### Eval and quality plan

This is needed whether or not roles ship, and it gates adding the second facet.

- **Offline harness.** Scripted conversations against a recorded fake tool
  layer (the `in-process-api` seam and `streamTextImpl` test seam in
  `turn.ts`), run against a real model on demand. Assertions are on behaviour,
  not wording: which tools were called, which weren't, whether a write was
  proposed, whether it refused a secret, whether it asked for clarification on
  an ambiguous task reference. A small set per facet: the Organizer set comes
  from today's instructions; the Researcher set adds "must not propose a write",
  "must call recall with a code scope for a code question", "must cite".
- **Prompt regression.** The harness runs on any change to `instructions.ts`
  or a facet, as an on-demand job, not a PR gate (it spends tokens).
- **Production signals, per role.** Thumbs (`turn-feedback.ts`) split by
  `agent_role_slug`; approval approve/deny rate; the rate of switching back to
  the Organizer within a few turns (a Researcher people abandon isn't pulling
  its weight); turns per conversation.
- **Ship bar for a new facet:** passes its harness set, and doesn't regress the
  Organizer set.

## Implementation sketch

**Now (no-regret):**

1. Chat eval harness with an Organizer scenario set. Load-bearing: nothing else
   should change chat prompts without it.
2. `chatFacetFor(slug)` with one `organizer` entry; `turn.ts` reads it;
   byte-identical test.
3. Teach the one chat agent to answer code questions from `recall` with a code
   scope instead of saying it can't read the repository.

**Later (when a revisit trigger fires), in order:**

4. Researcher facet in code + harness set; hidden behind a per-team flag.
5. Switching: header chip, event row, expire-on-switch, `PATCH` on the
   conversation's role, handoff affordance.
6. `workspace_skills.chat_facet` column (via `.claude/skills/schema-change`),
   admin editor tab, eligibility rules for scoped roles.
7. Per-role signals on the chat analytics surface.

## Open questions

- **Should Researcher-style behaviour just be the default?** If item 3 makes
  the one agent good at code questions, the Researcher's remaining difference
  is "can't file work", which may not be worth a mode at all. Lean: find out
  from the harness before building item 4.
- **Per-turn routing to a role.** The router could pick a facet per turn the
  way it picks a tool group, with no picker at all. Lean against for now: the
  identity would change under the user without them asking, and approvals get
  harder to reason about.
- **Do role directives (memory tier `directive`) apply per role or per
  conversation owner?** Lean: per owner, shared across roles, because the user
  experiences one buildd.
- **Should a facet be able to narrow `recall` scopes for a custom role** (e.g.
  a finance role that only sees its workspace's knowledge)? Lean yes, as a
  narrowing like tool groups, but it's not needed until custom roles exist.

## Non-goals

- Running any runner role's prompt, tool allowlist, `maxTurns` or backend in
  chat.
- Mounting a role's `mcpServers` or env vars in server-side chat. That's its
  own design, and the thing most likely to make custom roles worth it.
- Letting a facet widen anything: tools, write classes, reach, tier, or card
  skipping.
- Multi-agent conversations (two roles answering in one thread).
- A per-user model picker; tiers stay the admin's mapping (`agent-chat.md` →
  Models).
