# Chat write approval v2: confirm the translation, not the intent

**Status:** Proposed
**Related:** `packages/ai-kit/src/chat/server/permissions.ts` (`skipCardVerdict`, `canSkipCard`, `contentInContext`, `toolOutputInHistory`), `packages/ai-kit/src/chat/server/turn.ts` (`ONE_CARD_PER_TURN_REASON`, the `toolApproval` hook), `packages/ai-kit/src/chat/server/approvals.ts` (`reconcileApprovals`, `previewMatches`), `packages/ai-kit/src/chat/contract/index.ts` (`ApprovalPreview`), `packages/ai-kit/src/chat/react/cards.tsx`, `packages/ai-kit/src/decide/index.ts` (`gateChoice`), `apps/web/src/lib/chat/turn.ts`, `apps/web/src/lib/chat/permissions.ts`, `apps/web/src/components/chat/ApprovalCard.tsx`, `packages/core/decision-client.ts`, `docs/design/agent-chat.md` (Tools and permissions), `docs/design/shared-ai-kit.md` (Tool permissions), `docs/design/decision-calls.md`, `docs/design/connectors-and-orgs.md` §7

---

## Problem

In a recent session, a person set up several email filters from buildd chat.
The filters were auto-dismiss rules on specific senders, written through a
connector's `mute_sender` tool. The agent read the inbox and suggested some
senders. The person named the ones they wanted in a few words, and the agent
then proposed one write per sender. What happened next:

- **One card per write, one turn per card.** The first write got a card. Every
  later write in that turn was denied with `ONE_CARD_PER_TURN_REASON`, so the
  agent said it had "hit the one-card-per-turn limit, say go". Setting up N
  filters took N turns and N taps. The person's question was fair: *if it's my
  intent, why am I confirming?*
- **A phantom "discarded" row.** Most turns also showed a second settled row,
  `Mute sender · discarded · nothing changed`, which the person never
  discarded. The write the turn cap denied ends in `output-denied`, and
  `ApprovalCard` renders every `output-denied` part as a discard
  (`packages/ai-kit/src/chat/react/cards.tsx:140`,
  `apps/web/src/components/chat/ApprovalCard.tsx:117-119`). That bug is filed
  separately. This design removes the cap-denied write in the common case.
- **The one card that earned its keep.** One proposal widened silently. The
  person had been shown a single survey address at a reviews site
  (illustrative: `survey@reviews.example`), but the write targeted the whole
  domain (`reviews.example`). The card showed the pattern, which is the only
  reason the widening was visible.

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
their own**, and fixing any one of them changes nothing:

| Rule | Held? | Why |
|---|---|---|
| `tainted` | **Failed**, reported first | The agent read the inbox before writing. `toolOutputInHistory` is sticky: any tool part in the stored conversation taints every later turn, so saying "go" on a fresh turn did not clear it. |
| `group_not_allowed` / `unknown_tool` | **Failed** | buildd's tools menu and `CHAT_TOOL_GROUPS` list only buildd-native groups (Missions, Tasks, Agents, Knowledge, Schedules, Artifacts, PRs, Admin, Secrets). A connector tool is in no group, so the person could not set it to Allow. The kit's `createChatTurn` goes further and refuses to register a tool that no group declares (`ToolGroupsError`). |
| `input_not_skippable` | **Failed** | Cue's own declaration of `mute_sender` leaves `action` out of `skippableFields` on purpose, because `auto_noise` sets up a standing rule. Even in Cue's own chat, with its Email group set to Allow, this call always asks. |
| `already_skipped_this_turn` | Would fail from the 2nd write | Only one skip per turn. As `agent-chat.md` puts it, "the write's own result is tool output, so a second write in the same turn gets a card anyway". |
| One card per turn | Failed from the 2nd write | `cardsThisTurn >= 1` in the kit, `approvalsThisTurn >= 1` in buildd. The model is told to ask again later. |

**Can a connector write be Allowed today? No.** `connectors-and-orgs.md` §7
proposes chat connectors ("`write` needs an approval card naming the
identity"), but neither `dev` nor `main` registers connector tools in buildd
chat yet. There is no group for them, no preview contract and no inverse. So
the most today's rules can offer this session is fewer turns, not fewer taps.
The contract in "Connector tools" below is new ground, not a relaxation.

## Proposal

### The crux

**Provenance: did this write's target, scope and change come from the person's
own words, or from something the model read?** Everything else in this design
is plumbing around that one decision.

The rule is asymmetric. **Tool-derived content can only move a write toward a
card, never away from one.** The person's own messages, and objects they
explicitly docked or selected, are the only inputs that can make a write run
without a tap. Tool output can narrow what counts as "named" (see Scope), but
never widen it.

If the classification is wrong in the permissive direction, an injected
instruction could run a write without a tap. Three bounds apply regardless:

- only reversible writes can skip;
- every skipped write shows up as a receipt row with Undo;
- a turn can produce at most three receipts.

If it is wrong in the strict direction, the person gets a card, which is what
happens today.

### Tiered outcome per write

Every write the model proposes gets exactly one outcome. The order matters:
the first matching row wins.

| # | Condition | Outcome |
|---|---|---|
| 1 | Preview doesn't resolve (`ok: false`), whatever the class | **No card.** The tool answers `Needs clarification: …`, as today. |
| 2 | Admin class, or has `confirmText` | **Card, alone.** Exactly as today: the person types the target's name, and the admin write is the turn's only card. |
| 3 | Spends, sends to anyone else, starts unattended work, deferred, unknown, or has no declared inverse (irreversible) | **Card row**, whatever the provenance. |
| 4 | Group not set to Allow by this person | **Card row.** Allow stays opt-in, so shipping this changes nothing by default. |
| 5 | Target not user-named, or scope broader than named, or (in a tainted conversation) the change not accounted for by the person's words | **Card row.** A broadened row is flagged on the card. |
| 6 | Otherwise, while under the per-turn receipt cap | **Runs.** Shown as a receipt row with Undo, no tap. |
| 7 | Would be 6, but the cap is spent | **Card row.** Never denied. |

"Sends to others" is a new per-tool flag (`sendsToOthers`), next to `spends`
and `startsUnattendedWork`. It covers email, push notifications, comments on
GitHub, and posting to Slack. Instructing the running agent that the person
owns (for example, a hold telling it to pause) doesn't count.

**Standing rules** such as a mail filter are split two ways, because
`startsUnattendedWork` currently lumps two different things together:

- A rule that acts outward or spends (a schedule, arming a mission, a runner
  job) stays in row 3.
- A rule whose effects are internal, visible and reversible can qualify for
  row 6. An example is a filter that only moves or labels items the person can
  restore. It qualifies only if its inverse also undoes what the rule did while
  it was live (see Undo).

Whether Cue's `auto_noise` meets this bar is Cue's call (non-goal), and is the
first question for Cue's card task.

### Target provenance

Each write declares its **target fields**: the input fields that name what is
changed. A call that has target fields but no resolving preview never skips.
The server-built preview carries the target's identity:

```ts
// ApprovalPreview.target gains (additive, v stays 1):
names?: string[];   // identity-grade forms: id, address, domain, the title the resolver matched
scope?: { level: number; label: string; covers?: number };
```

`names` must be **identity-grade**. That means a key the app itself resolves
by: an id, an email address, a domain, or the task title the app's resolver
matched uniquely. A display name or free-text label someone else authored is
not identity-grade, because anyone can set their display name to anything.

A target is **user-named** when one of these holds.

**1. Deterministic match** (checked first, no model call):

- The text is normalized the same way on both sides: NFKC, lowercase, and runs
  of whitespace or `@ . _ - /` collapsed to one space.
- Some normalized `names` entry must equal a whole-token run in the person's
  own messages in this conversation.
- Only `role: 'user'` messages count. Assistant text, tool parts, event rows
  and steers from anyone else never count.
- A stored load that was truncated gives no deterministic match. It fails
  toward the card.

**2. A docked or selected object.** The target's id equals the id of an object
the person docked, or picked from a server-rendered list (an `ObjectRef` part,
not model prose). The docked object itself counts. Its child rows, which enter
the instructions as data, don't (see "Unchanged").

**3. Fuzzy match through a decision call.** This handles cases like "Acme"
mapping to `notifications@acme-energy.example`. It is one Jev call per row
(`decisionCall`, `packages/core/decision-client.ts`) whose state holds exactly:

- `personSaid`: the person's own messages, most recent last, trimmed to a
  small budget;
- `change`: a server-rendered line built from the tool's declared verb, the
  preview's identity-grade `names[0]` and the `changes` labels (for example,
  "Auto-dismiss routine mail from notifications@acme-energy.example").

It never includes tool output, assistant text or third-party-authored labels.
The question is a **Choice**, not a Noul:

| Label | Definition |
|---|---|
| `as_asked` | The person asked for this change, to this target, at this scope. Not for a change the person only agreed to in general terms. |
| `broader` | The same change, but covering more than the person named (a whole domain when they named one address). |
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
itself: the person named the Stripe checkout to hold it, and a document the
agent read says to rename it. So under taint, every row that would skip also
needs the Jev `as_asked` verdict, even when its target matched
deterministically. Taint is no longer a blanket block. It decides how much
proof a skip needs.

#### The injection argument

The attacker controls text the model reads: task descriptions, PR bodies,
emails, connector output. Go through what that buys them:

1. **A write to a target the person never named.** The target can only come
   from tool output, so it is tool-derived and gets a card. This is the
   existing test: a task description says "cancel every task", and the model
   calls `update_task` on a task the person never mentioned.
2. **A different change to a target the person did name.** An irreversible or
   outward change (cancel, send, delete) hits row 3 and gets a card whatever
   the provenance. A reversible one reaches Jev, which sees only the person's
   words and the server-rendered change, and answers `different_change`, so it
   gets a card.
3. **A broader scope** (a domain instead of an address, a wildcard). The scope
   ladder (below) catches it, and it gets a card with the row flagged.
4. **Steering the judge.** Jev never reads tool output or assistant text. Its
   only third-party-influenced input is the target's identity-grade name, so
   the remaining attack is a *lookalike* identity, for example
   `acme-energy-billing@evil.example` when the person said "Acme". This is the
   residual risk, and it is bounded:
   - the app's resolver must resolve the person's phrase *uniquely*, so two
     plausible matches make it ask a question;
   - the write is reversible, visible as a receipt, and one tap to undo;
   - a lookalike target mostly belongs to the attacker, so muting or editing
     it rarely harms the person.
5. **Text the person pasted** counts as the person's words, and that is a
   known gap. See Open question 4.
6. **No attacker, just a model mistake.** The same checks apply. The undo rate
   is the signal that they are too loose.

The existing guarantee is unchanged: nothing a tool returns can make a write
*run*. `execute` still refuses a call that has neither an approval this request
won nor a skip recorded by the approval hook, and it rebuilds the preview
before running.

### Scope

A tool whose target can cover more than one object declares a **scope ladder**
per target kind: ordered levels, narrowest first. Examples are patterns,
rules, filters and bulk edits. For a sender, the ladder might be
`address + subject` < `address` < `domain` < `any`. The app defines the ladder
(the kit only compares levels). The preview reports the write's `scope.level`,
and optionally `covers`, the number of existing items it would touch right now.

The **named level** is the narrowest level at which that same entity appeared
earlier in the conversation. That includes what the person typed, and also
what was *shown* to them: assistant text, earlier cards and tool rows. Shown
content counts here because it can only lower the named level, which makes the
check stricter. That is the asymmetry again.

A write whose level is above the named level is **broadened**. It becomes a
card row with a visible flag, "Broader than the survey address you were
shown", and it starts unchecked. That is exactly the reviews-site case.
`covers` above the tool's declared `maxSkipCovers` also means a card, whatever
the level.

A single-object tool (edit this task) has an implicit one-level ladder and
declares nothing. A multi-target tool with no ladder always gets a card.

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
  targetFields: ['senderPattern'],
  skippableFields?: [...],
  preview?: { tool: 'preview_mute_sender' },   // a read tool on the same connector
  undo?: 'token' | { tool: 'unmute_sender', input: { senderPattern: '$input.senderPattern' } },
  scopeLadder?: { kind: 'sender', levels: ['address+subject', 'address', 'domain', 'any'] },
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
    its own before-state, which only it can do correctly for a standing rule's
    accrued effects.
  - A mapped inverse tool: kept for connectors that can't mint tokens.
- **Nothing declared.** No preview means a card built from the raw input, as
  the kit does today without `preview`. No undo means irreversible, which is
  row 3: always a card, never a skip. An unclassified tool isn't offered at
  all. **The default for a connector is always a card, with no skip.**
- **A menu row per connector.** Each chat connector becomes its own group in
  the tools menu, labelled with the connector's name. Its switch is *Ask first*
  or *Allow* if at least one write declares both a preview and an undo.
  Otherwise the row is locked to *Ask first*. The preference is stored in the
  existing per-person column.

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
  denied per its toggle.
- **Shapes.** The card picks its header from the rows' previews:
  - *batch*: every row has the same verb, for one intent across many targets.
    The header is the verb, for example "Auto-dismiss 4 senders", and each row
    shows its target and change.
  - *combo*: every row has the same `target.id`, for many intents on one
    subject. The header is the subject, and each row shows its verb and change.
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
  the turn's step limit (`maxSteps: 8`) usually produces.
- **Admin stays alone.** A row that needs `confirmText` is never batched. If a
  turn proposes one, it is that turn's only card, and every other write in the
  turn is held back with today's reason. This is exactly today's behaviour.

For the session in the Problem, v2 doesn't produce receipts. The targets were
suggested by the agent from the inbox, and the person agreed to that
translation, so they are tool-derived. What v2 gives instead is **one turn,
one card, several rows and one tap**. The reviews-site row is flagged as
broader than the survey address the person was shown, and it starts unchecked.
Receipts are for the other half, when the person types the names and the change
themselves.

### Receipts and the per-turn cap

A write that skips its card still streams as its tool row. The row settles
into a **receipt**: what changed (the same before → after lines a card would
show), tagged `allowed` as today, with an **Undo** button while the undo is
live.

The first-skip-per-turn limit becomes **at most three receipts per turn**. A
fourth eligible write becomes a card row. It isn't denied, so nothing is lost.
The reasoning:

- A receipt's safety rests on the person *noticing* it. Three changed lines
  can be read at a glance; ten can't.
- It bounds what a model loop or a misclassification can do before the person
  looks.
- The old limit was mostly a side effect of taint: the first write's own
  result tainted the second. v2 scopes taint to what the model read, so the
  bound has to be stated explicitly.

### Undo contract

A write tool can declare an inverse. Without one it is irreversible and never
skips.

| Class | Inverse | Valid while |
|---|---|---|
| Field edit (title, description, priority, criteria, a date) | Set the fields back to the preview's before-values | The target's fingerprint still equals the after-fingerprint |
| Toggle state (hold ↔ unhold, mute ↔ unmute) | The opposite toggle | Same |
| Create an object | Delete it, as an undo-only path that bypasses the admin class | The object is untouched: not claimed, not edited, no children |
| Standing rule (a filter) | Remove the rule **and** restore what it acted on while it was live | The connector or app can do both. Otherwise it is irreversible. |
| Send, notify, spend, hand-off, delete, cancel a running task | None | Never, so always a card |

**Storage.** A kit store method, `recordReceipt`, with a reference table
`chat_receipts`:

- `conversation_id`, `message_id`, `tool_call_id` (unique);
- `tool`, `target_kind`, `target_id`;
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

If the fingerprint changed, it runs nothing and shows the current state ("Acme
Energy's filter changed since; here's what it is now"). The tap is the
consent, so an undo that restores a held task to running is not treated as
"starts unattended work". It only restores the state that existed before the
person's own write, within the TTL.

**TTL.** 24 hours by default. A tool may declare less, and a connector's
`expiresAt` caps it. The kit enforces a 7-day maximum. After expiry the receipt
stays, and Undo becomes "Undo expired: ask to change it back".

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
- **A docked object still forces a card** in v2's first cut. The existing test
  "with tasks allowed, a docked mission still gets a card" stays green. Letting
  the docked object count as user-selected is Open question 3.
- **The approval path itself.** Stored parts are the truth. Approval id, input
  hash and approver are matched through one compare-and-set per row, and
  `previewMatches` runs at execute time.
- **Allow stays opt-in** per person per group. Every group defaults to *Ask
  first*.

Two tests change on purpose, because they pin exactly the rules v2 replaces:

- the kit's "only the first Allowed write of a turn skips; the second gets the
  card" becomes "the fourth gets a card row";
- one-card-per-turn assertions become "one card, N rows, overflow is *not
  proposed yet*".

## Implementation sketch

In order, load-bearing first. Each step ships alone and is a no-op until turned
on.

1. **A pure provenance classifier in the kit.** `writeTier(facts)` returns a
   verdict (`card-alone | card | card-flagged | receipt | clarify`) and a
   reason. It is a superset of `skipCardVerdict`, and it takes the person's
   messages, docked and selected ids, the preview's `names` and `scope`, and
   the Jev outcome. It is table-tested against every row of the tier table,
   and against the injection cases above.
2. **Multi-row cards.** Replace the `cardsThisTurn`/`approvalsThisTurn` cap
   with the 8-row cap and `ROW_CAP_REASON`. `<ApprovalCard>` groups the pending
   parts of one assistant message, with toggles and one confirm. This changes
   nothing about what runs, only how many cards are needed, so it can ship
   before anything else.
3. **Shadow provenance** (see Rollout).
4. **Receipts, the undo endpoint and the `chat_receipts` store**, then buildd's
   inverse declarations for its skippable writes.
5. **The connector contract** from the catalog, then the first connector.

buildd still runs its own turn loop (`apps/web/src/lib/chat/turn.ts`) beside
the kit's `createChatTurn`, and shares only the pure rule set. Steps 1 and 2
land in the kit as pure functions and components, and buildd calls them from
its hook the same way it calls `CHAT_TOOL_GROUPS.canSkipCard` today.

## Rollout and metrics

**Shadow first.** Behind a per-app flag that defaults off, the approval hook
computes `writeTier` for every write and records a **content-free** record
under the assistant message's `usage.approvals`. That is the same place and
discipline as the chat routing record, with labels only and never text:

- tool, tier, reason and provenance path (`deterministic`, `docked`, `jev`,
  or `none`);
- the Jev label and confidence;
- the scope level against the named level;
- `wouldHaveSkipped`.

Behaviour is unchanged: the card still shows.

**The benchmark.** Label the shadow set by hand, then pick Jev's threshold `T`
from the coverage/accuracy table on a held-out split
(`scripts/decision-benchmark.ts`), as `decision-calls.md` requires. A would-
have-skipped card that the person then **denied**, or approved only after an
edit, is a pre-launch false positive.

**Then receipts,** per app, for people who set a group to Allow.

**Metrics:**

- **Taps per executed write.** This is the headline number. Today it is 1.0 by
  construction for anything read-after.
- **Turns per multi-write intent.** This measures the one-card cap directly.
- **Undo rate on receipts.** This is the real false-positive signal: a receipt
  undone within the TTL is a write the person didn't want. It gets an alarm
  threshold, and an automatic fallback to cards for that app when the rate is
  crossed over a rolling window.
- **Deny rate on would-have-skipped cards** during shadow.
- **Per-row refusal rates**: "changed since" and "not proposed yet".
- **Jev gate coverage and accuracy**, plus the `broader` and
  `different_change` rates.

## Open questions

1. **Should Allow stay opt-in for receipts?** I lean yes for launch: design
   rule 2 says defaults must be no-ops. After shadow data shows a low undo
   rate, groups whose writes all declare an inverse could default to Allow.
   That turns "if it's my intent, why am I confirming?" into the default, and
   it is the owner's call.
2. **Legacy Allow for writes with no inverse.** Today an untainted first write
   in an Allowed group skips with no undo, for example creating a mission.
   Under the tier table, a write with no inverse is row 3. I lean toward
   keeping legacy Allow until buildd declares inverses for its skippable
   writes, then retiring it, so the table becomes literally true. Retiring it
   at once would turn some of today's skips back into cards.
3. **Should docked objects count as user-selected?** I lean yes for the docked
   object itself, and no for its child rows, but only after shadow shows the
   Jev path holds up. Until then, docked forces a card, as today.
4. **Pasted text.** Content the person pasted counts as their words, so a
   pasted phishing email could name a target. I lean toward having kit clients
   mark pasted blocks and excluding them from provenance. That needs a client
   change in every app.
5. **A typed "yes" answering a pending card.** When a card is open and the
   person types "sure", should that approve it? I lean no. With one card per
   turn, the tap is cheap, and prose is ambiguous about which rows it means.
6. **The receipt cap and the TTL.** I've proposed three receipts per turn and a
   24-hour TTL. Both are guesses to validate against the undo-rate and
   time-to-undo data from the first weeks.
7. **Standing rules.** Is "the inverse also restores what the rule did" the
   right bar for a filter to skip, or should standing rules always ask, as
   Cue's `mute_sender` declaration does today? I lean toward the bar. The
   session in the Problem is the case it exists for.

## Non-goals

- Implementation. This is a design; each step in the sketch is its own task.
- Cue's filter semantics: its scope ladder for senders, whether `auto_noise`'s
  inverse can restore dismissed mail, and its preview tool. Cue's card task
  decides those against the contract here.
- The phantom "discarded" row for a cap-denied write. It is filed separately.
  v2 removes the common cause, and the row-cap overflow gets its own state.
- Changing how reads work, what taints, or who may propose an admin write.
- Model-authored proposals rendered as structured, server-resolved lists
  (a "propose" part). That would let a person's reply select from them. It is
  a possible follow-up once multi-row cards exist.
