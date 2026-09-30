# Chat write approval v2: confirm the translation, not the intent

**Status:** Proposed
**Related:** `packages/ai-kit/src/chat/server/permissions.ts` (`skipCardVerdict`, `canSkipCard`, `contentInContext`, `toolOutputInHistory`), `packages/ai-kit/src/chat/server/turn.ts` (`ONE_CARD_PER_TURN_REASON`, the `toolApproval` hook), `packages/ai-kit/src/chat/server/approvals.ts` (`reconcileApprovals`, `previewMatches`), `packages/ai-kit/src/chat/contract/index.ts` (`ApprovalPreview`), `packages/ai-kit/src/chat/react/cards.tsx`, `packages/ai-kit/src/decide/index.ts` (`gateChoice`), `apps/web/src/lib/chat/turn.ts`, `apps/web/src/lib/chat/permissions.ts`, `apps/web/src/lib/chat/registry.ts`, `apps/web/src/components/chat/ApprovalCard.tsx`, `packages/core/decision-client.ts`, `docs/design/agent-chat.md` (Tools and permissions), `docs/design/shared-ai-kit.md` (Tool permissions), `docs/design/decision-calls.md`, `docs/design/connectors-and-orgs.md` §7

---

## Problem

Chat asks for a tap on every write, including writes whose target and change
the person just typed themselves. "Hold the three checkout tasks until the
rounding fix lands" costs three turns and three taps today. "Create a mission
for the billing export" costs a tap after a turn in which the agent only read
the workspace. The person's fair question is: *if it's my intent, why am I
confirming?*

One session made every part of this visible. A person set up several
auto-dismiss rules on email senders from chat, through a connector write. The
agent read the inbox and suggested senders. The person named the ones they
wanted in a few words, and the agent proposed one write per sender:

- **One card per write, one turn per card.** The first write got a card. Every
  later write in that turn was denied with `ONE_CARD_PER_TURN_REASON`, so the
  agent said it had "hit the one-card-per-turn limit, say go". N writes took
  N turns and N taps.
- **A phantom "discarded" row.** Most turns also showed a second settled row,
  `… · discarded · nothing changed`, which the person never discarded. The
  write the turn cap denied ends in `output-denied`, and `ApprovalCard` renders
  every `output-denied` part as a discard
  (`packages/ai-kit/src/chat/react/cards.tsx:140`,
  `apps/web/src/components/chat/ApprovalCard.tsx:117-119`). That bug is filed
  separately. This design removes the cap-denied write in the common case.
- **The one card that earned its keep.** One proposal widened silently. The
  person had been shown a single address at a site, but the write targeted the
  whole domain. The card showed the pattern, which is the only reason the
  widening was visible.

The card exists because the model may have turned the person's words into
something different: a wrong target, a broader scope, or a change it was
steered into by tool output. Today the kit can't tell a write that needs
translation from one that doesn't, so it confirms both. It also can't show
more than one write per card.

## Current state: why today's rules fired

`skipCardVerdict` (`permissions.ts`) checks its rules in a fixed order and
reports the first one that fails. The order is `tainted`, `docked`,
`nothing_allowed`, `already_skipped_this_turn`, `unknown_tool`, `not_write`,
`unattended`, `spends`, `input_not_skippable`, `group_not_allowed`. buildd's own
gate (`apps/web/src/lib/chat/turn.ts:401-436`) runs the same rules through
`CHAT_TOOL_GROUPS.canSkipCard` and keeps its own per-turn counters.

For the session above, **several rules would each have forced the card on
their own**, and fixing any one of them changes nothing. The same rules fire
for buildd's own writes:

| Rule | Held? | Why |
|---|---|---|
| `tainted` | **Failed**, reported first | The agent read something before writing (the inbox; for buildd, `list_tasks`). `toolOutputInHistory` is sticky: any tool part in the stored conversation taints every later turn, so saying "go" on a fresh turn does not clear it. |
| `docked` | Fails whenever an object is docked | A docked mission forces a card even for a write to that mission itself. |
| `group_not_allowed` / `unknown_tool` | **Failed** for the connector | buildd's tools menu and `CHAT_TOOL_GROUPS` list only buildd-native groups. A connector tool is in no group, so the person could not set it to Allow. The kit's `createChatTurn` refuses to register a tool that no group declares (`ToolGroupsError`). |
| `input_not_skippable` | **Failed** for the connector | The connector app's own declaration leaves the rule-setting field out of `skippableFields` on purpose, because it sets up a standing rule. |
| `already_skipped_this_turn` | Would fail from the 2nd write | Only one skip per turn. As `agent-chat.md` puts it, "the write's own result is tool output, so a second write in the same turn gets a card anyway". |
| One card per turn | Failed from the 2nd write | `cardsThisTurn >= 1` in the kit, `approvalsThisTurn >= 1` in buildd. The model is told to ask again later. |

**Can a connector write be Allowed today? No.** `connectors-and-orgs.md` §7
proposes chat connectors ("`write` needs an approval card naming the
identity"), but neither `dev` nor `main` registers connector tools in buildd
chat yet. There is no group for them, no preview contract and no inverse. The
contract in "Connector tools" below is new ground, not a relaxation.

## Proposal

**Stance: assume a good model. Undo beats ask wherever an inverse exists.** A
tap guards against a mistranslation; an Undo on a receipt fixes one after the
fact at the same cost, and costs nothing when the model got it right, which is
the common case. So a card is kept for writes that can't be undone, whose
blast radius is larger than what the person named, or whose target or change
did not come from the person.

### The crux

**Provenance: did this write's target, scope and change come from the person's
own words, or from something the model read?** Everything else in this design
is plumbing around that one decision.

The rule is asymmetric. **Tool-derived content can only move a write toward a
card, never away from one.** The person's own typed messages, and objects they
explicitly docked or selected, are the only inputs that can make a write run
without a tap. Tool output can narrow what counts as "named" (see Scope), but
never widen it.

If the classification is wrong in the permissive direction, an injected
instruction could run a write without a tap. Three bounds apply regardless:

- only writes with a declared inverse can skip;
- every skipped write shows up as a receipt row with Undo;
- the preview's blast radius (scope level and `covers`) must not exceed what
  the person named, and a runaway guard stops unattended or looping turns (see
  Receipts).

If it is wrong in the strict direction, the person gets a card, which is what
happens today.

### Tiered outcome per write

Every write the model proposes gets exactly one outcome. The first matching
row wins.

| # | Condition | Outcome | buildd examples |
|---|---|---|---|
| 1 | Preview doesn't resolve (`ok: false`), whatever the class | **No card.** The tool answers `Needs clarification: …`, as today. | "hold the checkout task" when two tasks match |
| 2 | Admin class, or has `confirmText` | **Card, alone.** Exactly as today: the person types the target's name, and the admin write is the turn's only card. | delete a mission, `delete_schedule`, `trigger_release` |
| 3 | Spends, sends to anyone else, starts unattended work, deferred, unknown, or has no declared inverse (irreversible) | **Card row**, whatever the provenance. | `manage_missions` arm, `create_schedule` / `update_schedule`, cancel a running task, `send_agent_message` |
| 4 | Group is on *Ask first* (the person's choice, a group with a write that has no inverse, or the undo-rate tripwire) | **Card row.** | any write in a group the person set to Ask first |
| 5 | Target not user-named, or scope or `covers` broader than named, or (in a tainted conversation) the change not accounted for by the person's words | **Card row.** A broadened row is flagged and starts unchecked. | `update_task` on a task only `list_tasks` surfaced; `pause_schedules` on every schedule when one was named |
| 6 | Unattended or looping turn past the runaway guard | **Card row.** Never denied. | a watch-triggered turn that keeps proposing edits |
| 7 | Otherwise | **Runs.** Shown as a receipt row with Undo, no tap. | `hold_task` hold/resume on a task the person named, `update_task` priority, `create_task` or `manage_missions` create from the person's words, `learn` |

"Sends to others" is a new per-tool flag (`sendsToOthers`), next to `spends`
and `startsUnattendedWork`. It covers email, push notifications, comments on
GitHub, posting to Slack, and messages to another person. Instructing the
running agent that the person owns (for example, a hold telling it to pause)
doesn't count.

**Standing effects.** `startsUnattendedWork` currently lumps two things
together, so v2 adds a separate `standing` inverse class:

- a write that acts outward or spends later (a schedule, arming a mission, a
  runner job) stays `startsUnattendedWork` and row 3;
- a write that installs a rule whose effects are internal, visible and
  reversible can declare `standing`. It qualifies for row 7 only if its
  inverse also reverses the effects the rule already applied while live (see
  Undo contract).

What a given app's rules are, how they are scoped, and whether they meet the
bar is that app's decision, not this design's. The email filters in the
Problem are Cue's, and are decided in Cue task `8dddb6e6`.

### Target provenance

Each write declares its **target fields**: the input fields that name what is
changed. A call that has target fields but no resolving preview never skips.
The server-built preview carries the target's identity:

```ts
// ApprovalPreview.target gains (additive, v stays 1):
names?: string[];   // identity-grade forms: id, short id, number, address, the title the resolver matched
scope?: { level: number; label: string; covers?: number };
```

`names` must be **identity-grade**: a key the app itself resolves by. That is
an id or short id, a PR number, an address, or the task or mission title the
app's resolver matched uniquely. A display name or free-text label someone else
authored is not identity-grade, because anyone can set it to anything.

A target is **user-named** when one of these holds.

**1. Deterministic match** (checked first, no model call):

- The text is normalized the same way on both sides: NFKC, lowercase, and runs
  of whitespace or `@ . _ - / #` collapsed to one space.
- Some normalized `names` entry must equal a whole-token run in the person's
  own typed messages in this conversation.
- Only `role: 'user'` messages count, and within them only typed text. Pasted
  blocks, assistant text, tool parts, event rows and steers from anyone else
  never count.
- A stored load that was truncated gives no deterministic match. It fails
  toward the card.

**2. A docked or selected object.** The target's id equals the id of an object
the person docked, or picked from a server-rendered list (an `ObjectRef` part,
not model prose). The docked object itself counts: with a mission docked,
"rename it to Billing export v2" targets that mission. Its child rows, which
enter the instructions as data, don't: a task listed under the docked mission
is tool-derived unless the person names it.

**3. Fuzzy match through a decision call.** This handles cases like "the
flaky login one" mapping to the task titled `Fix intermittent login redirect
on Safari`, or "Acme" mapping to an address at `acme-energy.example`. It is
one Jev call per row (`decisionCall`, `packages/core/decision-client.ts`)
whose state holds exactly:

- `personSaid`: the person's own typed messages, most recent last, trimmed to a
  small budget;
- `change`: a server-rendered line built from the tool's declared verb, the
  preview's identity-grade `names[0]` and the `changes` labels (for example,
  "Hold task: Fix intermittent login redirect on Safari").

It never includes tool output, assistant text, pasted text or
third-party-authored labels. The question is a **Choice**, not a Noul:

| Label | Definition |
|---|---|
| `as_asked` | The person asked for this change, to this target, at this scope. Not for a change the person only agreed to in general terms. |
| `broader` | The same change, but covering more than the person named (every schedule when they named one). |
| `different_target` | The person named some other target, or none. |
| `different_change` | Right target, but the person asked for a different change or none. |

It passes only when `gateChoice(answer, T)` returns `as_asked`. Everything
else fails closed to a card:

- any other label;
- confidence below `T`;
- any `DecisionError` (no key, timeout, parse error);
- a 3s budget exceeded.

The threshold `T` comes from the benchmark (see Rollout), not a round number.
A Choice is preferred to a Noul because `decision-calls.md` Point 2 needs a
confidence to gate on, and a Noul has none. The losing labels also feed the
metrics directly (`broader` rate, `different_change` rate). Per rule 5 of that
doc, there is no extra yes/no question stacked on top.

**The change, not just the target.** In an untainted conversation, where
nothing has been read, the model is acting straight from the person's words,
and today's Allow already trusts that. Target and scope checks are enough
there. In a tainted conversation, the lever an injection has is the *change*
itself: the person named the checkout task to hold it, and a task description
the agent read says to rewrite its description. So under taint, every row that
would skip also needs the Jev `as_asked` verdict, even when its target matched
deterministically. Taint is no longer a blanket block. It decides how much
proof a skip needs.

**Pasted text.** Kit clients mark pasted blocks in the message parts, and
provenance excludes them. A pasted email, PR body or log can name a target,
and it is third-party text however it arrived. A client that doesn't mark
pastes can't prove any text was typed, so its conversations get no receipts:
every write is a card, as today. It fails closed.

#### The injection argument

The attacker controls text the model reads: task descriptions, PR bodies,
emails, connector output, anything pasted. Go through what that buys them:

1. **A write to a target the person never named.** The target can only come
   from tool output, so it is tool-derived and gets a card. This is the
   existing test: a task description says "cancel every task", and the model
   calls `update_task` on a task the person never mentioned.
2. **A different change to a target the person did name.** An irreversible or
   outward change (cancel a running task, send, delete, arm) hits row 3 and
   gets a card whatever the provenance. A reversible one reaches Jev, which
   sees only the person's typed words and the server-rendered change, and
   answers `different_change`, so it gets a card.
3. **A broader scope** (every schedule instead of one, a domain instead of an
   address). The scope ladder (below) catches it, and it gets a card with the
   row flagged.
4. **Steering the judge.** Jev never reads tool output, assistant text or
   pastes. Its only third-party-influenced input is the target's
   identity-grade name, so the remaining attack is a *lookalike* identity: a
   task titled `Fix login redirect (Safari) — urgent` planted beside the real
   one, or `acme-energy-billing@evil.example` when the person said "Acme". This
   is the residual risk, and it is bounded:
   - the app's resolver must resolve the person's phrase *uniquely*, so two
     plausible matches make it ask a question (row 1);
   - the write is reversible, visible as a receipt, and one tap to undo;
   - a lookalike target mostly belongs to the attacker, so editing it rarely
     harms the person.
5. **Text the person pasted** is excluded from provenance, and a client that
   can't mark pastes gets no receipts.
6. **No attacker, just a model mistake.** The same checks apply. The undo rate
   is the signal that they are too loose, and it has a tripwire (see Rollout).

The existing guarantee is unchanged: nothing a tool returns can make a write
*run*. `execute` still refuses a call that has neither an approval this request
won nor a skip recorded by the approval hook, and it rebuilds the preview
before running.

### Scope and blast radius

A tool whose target can cover more than one object declares a **scope ladder**
per target kind: ordered levels, narrowest first. `pause_schedules` is the
buildd case: `scheduleIds` < `namePattern` < every schedule in the workspace. A
connector's filter or bulk edit declares its own. The app defines the ladder;
the kit only compares levels. The preview reports the write's `scope.level`,
and optionally `covers`, the number of existing objects it would touch right
now.

The **named level** is the narrowest level at which that same entity appeared
earlier in the conversation. That includes what the person typed, and also
what was *shown* to them: assistant text, earlier cards and tool rows. Shown
content counts here because it can only lower the named level, which makes the
check stricter. That is the asymmetry again.

A write whose level is above the named level is **broadened**. It becomes a
card row with a visible flag, "Broader than the one schedule you named", and
it starts unchecked. That is exactly the widening in the Problem. `covers`
above the tool's declared `maxSkipCovers` also means a card, whatever the
level. A multi-target tool that declares no `maxSkipCovers` never skips.

A single-object tool (hold this task) has an implicit one-level ladder with
`covers: 1` and declares nothing. A multi-target tool with no ladder always
gets a card.

This per-write blast radius is what decides card versus receipt. There is no
per-turn or per-session count cap in interactive chat (see Receipts).

### Connector tools

A connector write is classified before chat offers it (`connectors-and-orgs.md`
§7). v2 adds what it must declare to get anything better than a raw-input card.

**The catalog entry is authoritative, not the MCP server.** MCP tool
annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint`) are hints from the server, and the MCP spec says a client must
not trust them from an untrusted server. They may **prefill** an admin's
classification. They never decide. The reviewed declaration lives buildd-side,
in the catalog entry (or an admin's classification of a custom connector):

```ts
// per write tool, in the connector's chat classification
{
  class: 'write',
  reach: 'caller' | 'team',
  sendsToOthers?: boolean, spends?: boolean, startsUnattendedWork?: boolean,
  targetFields: ['<field>'],
  skippableFields?: [...],
  preview?: { tool: '<read tool>' },   // a read tool on the same connector
  undo?: 'token' | { tool: '<inverse tool>', input: { '<field>': '$input.<field>' } },
  inverseClass?: 'field_edit' | 'toggle' | 'create' | 'standing',
  undoTtl?: '<duration>',               // overrides the class default
  scopeLadder?: { kind: '<target kind>', levels: ['<narrowest>', '…', '<widest>'] },
  maxSkipCovers?: number,
}
```

- **Preview.** A read-only tool on the same connector. It takes the write's
  input and returns the `ApprovalPreview` shape: verb, target with `names`,
  `scope`, `changes` and `fingerprint`. It runs server-side from the approval
  hook, so its output **never enters the model's context** and taints nothing.
  Its structured fields (`names`, `scope`, `fingerprint`) drive decisions. Its
  free-text labels are only displayed.
- **Undo.** There are two forms, and a token is preferred:
  - `'token'`: the write's result carries `_meta.undo = { token, expiresAt }`,
    and the connector's `undo` tool accepts the token. The connector captured
    its own before-state, which only it can do correctly for a `standing`
    write's applied effects.
  - A mapped inverse tool: kept for connectors that can't mint tokens.
- **Nothing declared.** No preview means a card built from the raw input, as
  the kit does today without `preview`. No undo means irreversible, which is
  row 3: always a card, never a skip. An unclassified tool isn't offered at
  all. **The default for a connector is always a card, with no skip.**
- **A menu row per connector.** Each chat connector becomes its own group in
  the tools menu, labelled with the connector's name. Its switch is *Ask first*
  or *Allow* if at least one write declares both a preview and an undo.
  Otherwise the row is locked to *Ask first*. The preference is stored in the
  existing per-person column, and the default follows the Decisions below
  (Allow only when every write in it declares an inverse).

### One card per turn, N rows

Delete the one-card cap. A turn's card-bound writes become **rows of one
card**. The server already supports this:

- each write is its own tool part with its own approval id;
- `approvalRequestsIn` records every pending part;
- `reconcileApprovals` decides each one through its own compare-and-set.

The change is the cap in the approval hook, plus the card component.

- **Rows.** Each row keeps its own approval id, input hash, preview,
  fingerprint and compare-and-set. Each has a **toggle**, on by default,
  except broadened rows, which start off. There is one button,
  "Confirm N". It sends one continuation answering every row, approved or
  denied per its toggle. Each row carries a short stable row id (its position,
  `1`…`8`) that typed replies can name.
- **Shapes.** The card picks its header from the rows' previews:
  - *batch*: every row has the same verb, for one intent across many targets.
    The header is the verb, for example "Hold 3 tasks", and each row shows its
    target and change.
  - *combo*: every row has the same `target.id`, for many intents on one
    subject. The header is the subject ("Billing export"), and each row shows
    its verb and change (rename, add a criterion, raise priority).
  - otherwise: "N changes", one row each.
- **Results per row.** On approval, each row runs only if it won its
  compare-and-set, its input hash matches, and its rebuilt preview passes
  `previewMatches`. A row that fails is refused on its own ("changed since the
  card was shown"), and the others still run. The settled card shows each row's
  outcome: done, changed since, discarded (toggled off), or failed.
- **Hard row cap: 8 rows per turn.** A write past the cap is not denied as a
  discard. It returns a distinct `ROW_CAP_REASON` ("The card is full; propose
  the rest after the person answers"), and it renders as *not proposed yet*,
  never as *discarded*. That fixes the phantom-discard class for the overflow
  case too. Eight rows fit a phone screen with the fold, and they are more than
  the turn's step limit (`maxSteps: 8`) usually produces. The row cap bounds a
  card's height; it is not a receipt cap.
- **Admin stays alone.** A row that needs `confirmText` is never batched. If a
  turn proposes one, it is that turn's only card, and every other write in the
  turn is held back with today's reason. This is exactly today's behaviour.

For the session in the Problem, v2 doesn't produce receipts. The targets were
suggested by the agent from what it read, and the person agreed to that
translation, so they are tool-derived. What v2 gives instead is **one turn,
one card, several rows and one tap** (or one typed "yes"). The widened row is
flagged and starts unchecked. Receipts are for the other half, when the person
types the names and the change themselves: "hold #412, #415 and #418 until the
rounding fix lands" is three receipts and no tap.

### Typed replies to an open card

When a card is open and the person types instead of tapping, the reply goes
down three paths, in order:

1. **Bare affirmative.** The whole message, trimmed, lowercased and with
   trailing punctuation dropped, is one of a fixed list: `yes`, `go`, `sure`,
   `do it`, `ok`. And there is exactly one open card in the conversation. Then
   it approves the rows that were **checked by default**; flagged (broadened)
   rows stay off. No model call.
2. **Anything longer or ambiguous** goes to a Jev **Choice** tiebreak whose
   state is the person's message plus the card's server-rendered rows (row id,
   verb, target, change) only. No tool output, no assistant text:

   | Label | Definition |
   |---|---|
   | `approve_as_proposed` | Approve the card as shown: the default-checked rows. |
   | `approve_subset` | Approve some rows, and the message names which. |
   | `new_request` | The message asks for something else, changes a row, or is a question. |
   | `unsure` | Can't tell. |

   It fails to `new_request`: any other label, confidence below its threshold,
   or any `DecisionError`. `approve_subset` counts only when every row it
   returns is **named in the message**, by its row id or by a deterministic
   match on the row's target name; otherwise it is `new_request`. It starts in
   **shadow**: logged, never acted on (it falls through to `new_request`) until
   the benchmark sets its threshold. `approve_as_proposed` is live from the
   start with its own benchmarked threshold.
3. **`new_request` or `unsure`.** The next model turn reads the message with
   the card's state in context. It may re-propose (a fresh card replaces the
   open one, whose rows settle as *superseded*) or call tools.

**The model never approves a card.** Only the tap, the bare-yes rule, or a Jev
`approve_*` verdict can, and each goes through the same per-row
compare-and-set as a tap, with the typing person as approver.

### Receipts

A write that skips its card still streams as its tool row. The row settles
into a **receipt**: what changed (the same before → after lines a card would
show), tagged `allowed` as today, with an **Undo** button while the undo is
live. A `standing` write may add an **effect summary** the tool declares ("has
acted on N items so far"), refreshed from its own read tool, so the person
sees what Undo will reverse.

**One block per turn.** Receipts from one turn group into one receipt block
with a per-row Undo and an **Undo all**. Undo all is one undo call per row, each
with its own compare-and-set, so a row that changed since reports that and the
rest still undo.

**No per-turn or per-session count cap in interactive chat.** A count cap
punishes exactly the case this design exists for: a person who types ten
names gets a card for the last seven. The bounds are instead:

- **Per-write blast radius** from the preview (scope ladder and `covers`,
  above) decides card versus receipt, row by row.
- **A runaway guard for unattended or looping turns only.** A turn not started
  by a person's message (a watch firing, an event-driven turn) never produces
  receipts: its writes are card rows, as today's `unattended` rule does. And in
  any turn, once the receipts reach a high threshold (default 20 per turn, an
  app setting), every further eligible write becomes a row of the turn's one
  card. A person typing names never reaches it; a model stuck in a loop does.

### Undo contract

A write tool declares an inverse and its **inverse class**. Without one it is
irreversible and never skips. TTL is declared per inverse class in the kit,
and a tool may declare longer or shorter.

| Class | Inverse | Valid while | Default TTL | buildd writes |
|---|---|---|---|---|
| `field_edit` | Set the fields back to the preview's before-values | The target's fingerprint still equals the after-fingerprint | 24h | `update_task` title/description/priority, `manage_missions` update (goal, criteria, priority), `manage_initiatives` update |
| `toggle` | The opposite toggle | Same | 24h | `hold_task` hold ↔ resume, `pause_schedules` pause ↔ resume |
| `create` | Cancel it if not started, as an undo-only path that bypasses the admin class | Not started: a task not claimed, a mission with no started task; not edited since | 24h | `create_task`, `manage_missions` create, `create_artifact`, `learn` (the memory is superseded) |
| `standing` | Remove the rule **and** reverse the effects it already applied while live | The app or connector can do both; otherwise it is irreversible | 24h; tools usually declare longer | an app's filter or auto-rule (Cue's are in task `8dddb6e6`) |
| none | — | Never, so always a card | — | send, notify, spend, hand-off, delete, arm, cancel a running task, `send_agent_message` |

A connector's token `expiresAt` caps whatever the class or tool declares.

**Storage.** A kit store method, `recordReceipt`, with a reference table
`chat_receipts`:

- `conversation_id`, `message_id`, `tool_call_id` (unique);
- `tool`, `target_kind`, `target_id`, `inverse_class`;
- `inverse`: `{ kind: 'mapped', tool, input }` or `{ kind: 'token', token }`,
  encrypted like any other secret-bearing blob;
- `after_fingerprint`, `expires_at`, `undone_at`, `undone_by`.

The mapped inverse input is computed **at execution time** from the preview's
before-state, not later from a fresh read.

**Undo is not a model turn.** `POST /api/chat/[id]/undo { toolCallId }` works
like this:

1. It makes one atomic compare-and-set on the receipt:
   `undone_at IS NULL AND expires_at > now()`, then `.returning()`. There is no
   interactive transaction (neon-http).
2. It rebuilds the preview and requires `after_fingerprint` to match.
3. It runs the inverse, and appends an event row "Undone: …".

If the fingerprint changed, it runs nothing and shows the current state ("The
checkout task changed since; here's what it is now"). The tap is the consent,
so an undo that resumes a task the person just held is not treated as "starts
unattended work". It only restores the state that existed before the person's
own write, within the TTL.

After expiry the receipt stays, and Undo becomes "Undo expired: ask to change
it back".

### After confirm

What the conversation does once a card is confirmed (collapsing steps, keeping
cards from moving, landing on the head of the reply) is a layout question, not
an approval one. It is specified in the chat scroll/layout task `c2f23f9c`, and
v2's multi-row card and receipt block follow it.

### Unchanged

- **The prompt-injection tests still produce a card**, unmodified:
  - `apps/web/src/lib/chat/turn.test.ts`: "prompt injection: a task
    description telling the agent to cancel tasks gets a card at most, never a
    write", and "with tasks allowed, the injection test still gets a card".
    The target there is tool-derived, and the change is a cancel (row 3).
  - `apps/web/src/lib/chat/steering.test.ts`: "every write op, called without
    this request's approval, performs no write".
  - `packages/ai-kit/src/chat/server/turn.test.ts`: the two taint tests. Their
    note titles were never in the person's words, so the targets are
    tool-derived.
- **Admin never skips.** Row 2, with `confirmText`, alone on its card.
- **The approval path itself.** Stored parts are the truth. Approval id, input
  hash and approver are matched through one compare-and-set per row, and
  `previewMatches` runs at execute time.
- **A person's Allow or Ask first** per group is respected; only the default
  changes (Decision 1).

Three tests change on purpose, because they pin exactly the rules v2 replaces:

- the kit's "only the first Allowed write of a turn skips; the second gets the
  card" becomes "every eligible write is a receipt, grouped in one block; past
  the runaway threshold the rest are card rows";
- one-card-per-turn assertions become "one card, N rows, overflow is *not
  proposed yet*";
- "with tasks allowed, a docked mission still gets a card" splits into "a write
  to the docked mission itself is a receipt" and "a write to one of its child
  tasks the person didn't name still gets a card".

## Implementation sketch

In order, load-bearing first. Each step ships alone and is a no-op until its
per-app switch is on.

1. **A pure provenance classifier in the kit.** `writeTier(facts)` returns a
   verdict (`card-alone | card | card-flagged | receipt | clarify`) and a
   reason. It is a superset of `skipCardVerdict`, and it takes the person's
   typed messages, docked and selected ids, the preview's `names` and `scope`,
   the Jev outcome and the turn's receipt count. It is table-tested against
   every row of the tier table, and against the injection cases above.
2. **Multi-row cards.** Replace the `cardsThisTurn`/`approvalsThisTurn` cap
   with the 8-row cap and `ROW_CAP_REASON`. `<ApprovalCard>` groups the pending
   parts of one assistant message, with toggles and one confirm. This changes
   nothing about what runs, only how many cards are needed, so it can ship
   before anything else.
3. **Typed replies.** The bare-affirmative rule, then the Jev tiebreak with
   `approve_subset` shadowed.
4. **Paste marking** in the kit's composer (and every kit client), so
   provenance can exclude pasted blocks.
5. **Receipts, the undo endpoint and the `chat_receipts` store**, with the
   receipt block and Undo all.
6. **buildd's inverse declarations** for its skippable writes (creates invert
   to cancel-if-not-started), then **retire legacy Allow** (Decision 2).
7. **The connector contract** from the catalog, then the first connector.

buildd still runs its own turn loop (`apps/web/src/lib/chat/turn.ts`) beside
the kit's `createChatTurn`, and shares only the pure rule set. Steps 1 to 3
land in the kit as pure functions and components, and buildd calls them from
its hook the same way it calls `CHAT_TOOL_GROUPS.canSkipCard` today.

## Rollout and metrics

**Shadow collects metrics; it is not a gate.** The approval hook computes
`writeTier` for every write and records a **content-free** record under the
assistant message's `usage.approvals`. That is the same place and discipline
as the chat routing record, with labels only and never text:

- tool, tier, reason and provenance path (`deterministic`, `docked`, `jev`,
  or `none`);
- the Jev label and confidence, for both the provenance and typed-reply calls;
- the scope level against the named level, and `covers`;
- `wouldHaveSkipped`.

**The benchmark.** Label a sample by hand, then pick each Jev threshold from
the coverage/accuracy table on a held-out split
(`scripts/decision-benchmark.ts`), as `decision-calls.md` requires. A
would-have-skipped card that the person then **denied**, or approved only after
an edit, is a false positive.

**Receipts default on** per app when its switch flips, for groups whose writes
all declare an inverse (Decision 1).

**The tripwire.** Undo rate on receipts is tracked per app and group over a
rolling window, with a minimum sample. Above ~5%, that group reverts to *Ask
first* and a note is raised to the app's owner. This is the safety property
for defaulting receipts on: a group whose translations people keep undoing
stops skipping on its own.

**Metrics:**

- **Taps per executed write.** The headline number. Today it is 1.0 by
  construction for anything read-after.
- **Turns per multi-write intent.** Measures the one-card cap directly.
- **Undo rate and time-to-undo on receipts,** per group and inverse class. The
  real false-positive signal, and the input for tuning each class's TTL.
- **Deny rate on would-have-skipped cards.**
- **Per-row refusal rates**: "changed since" and "not proposed yet".
- **Typed-reply paths**: share of bare-yes, `approve_*` and `new_request`, and
  how often an `approve_*` approval is followed by an undo or a correction.
- **Runaway guard trips,** which should be near zero in interactive chat.
- **Jev gate coverage and accuracy**, plus the `broader` and
  `different_change` rates.

## Decisions (Sep 30)

1. **Receipts default on** for any tool group whose writes all declare an
   inverse. This departs from the "defaults must be no-ops" rule in
   `DESIGN-FORMAT.md` on purpose: the whole point is that the default stops
   asking about the person's own words. The bound is the undo-rate tripwire
   above, and a person can still set any group to Ask first. Shadow runs only
   to collect metrics.
2. **Legacy Allow for writes with no inverse stays** until buildd declares
   inverses for its skippable writes (creates invert to cancel-if-not-started,
   step 6). Then legacy Allow is retired so the tier table has no exceptions.
   Follow-up: declare the inverses, then retire it.
3. **A docked object counts as user-selected**: the object itself, not its
   child rows.
4. **Pasted text is excluded from provenance.** Kit clients mark pasted blocks;
   a client that doesn't gets no receipts (fails closed).
5. **Typed replies to an open card** take three paths: bare affirmative with
   one open card approves the default-checked rows; anything else goes to a
   Jev Choice over the message and the rendered rows, failing to
   `new_request`, with `approve_subset` requiring named row ids and shadowed
   first; otherwise the next model turn handles it. The model never approves a
   card itself.
6. **No per-turn or per-session receipt cap in interactive chat.** Per-write
   blast radius from the preview decides card versus receipt; a runaway guard
   covers unattended and looping turns only. Receipts from one turn group into
   one block with per-row Undo and Undo all. TTL is declared per inverse class
   (default 24h), and tools can declare longer.
7. **Standing rules and filter semantics belong to the app that owns them.**
   This design keeps only the generic hook: a `standing` inverse class whose
   inverse must also reverse applied effects, with its own TTL and an effect
   summary for the receipt. Cue's filters (scope, TTL, what the receipt says)
   are decided in Cue task `8dddb6e6`.

## Non-goals

- Implementation. This is a design; each step in the sketch is its own task.
- Any app's own rule semantics: scope ladders for its targets, whether a
  given standing rule's inverse can reverse its effects, its preview tool, its
  TTL. For Cue's filters that is task `8dddb6e6`.
- The phantom "discarded" row for a cap-denied write. It is filed separately.
  v2 removes the common cause, and the row-cap overflow gets its own state.
- Chat scroll and layout after confirm (task `c2f23f9c`).
- Changing how reads work, what taints, or who may propose an admin write.
- Model-authored proposals rendered as structured, server-resolved lists
  (a "propose" part). That would let a person's reply select from them. It is
  a possible follow-up once multi-row cards exist.
