---
title: Chat Stream Composition
status: active
owner: max
last_verified: 2026-10-10
summary: An assistant chat turn MUST render in fixed, keyed regions so streaming text, finished tools and loading cards never move, reparent or duplicate what is already on screen.
domain: surfaces
surfaces: [packages/ai-kit/src/chat/react/Thread.tsx, packages/ai-kit/src/chat/react/model.ts, apps/web/src/components/chat/feed-model.ts, apps/web/src/components/chat/ChatWorkspace.tsx]
related: []
keywords: [jumpy chat, cards jump, answer replace, compose turn, phase results, Referenced, Created, approval resume, scroll anchor, follow mode]
verified_by: [packages/ai-kit/src/chat/react/turn.test.ts, packages/ai-kit/src/chat/react/turn.dom.test.tsx, apps/web/src/components/chat/feed-model.test.ts, apps/web/src/components/chat/ChatFeed.dom.test.tsx, apps/web/src/components/chat/ChatWorkspace.dom.test.tsx]
assertions:
  - id: compose-turn
    type: symbol
    name: composeTurn
    path: packages/ai-kit/src/chat/react/model.ts
  - id: turn-layout
    type: symbol
    name: turnLayout
    path: apps/web/src/components/chat/feed-model.ts
  - id: result-group-view
    type: symbol
    name: ResultGroupView
    path: apps/web/src/components/chat/objects/registry.tsx
  - id: compose-turn-dom-test
    type: test_file
    path: packages/ai-kit/src/chat/react/turn.dom.test.tsx
  - id: feed-model-test
    type: test_file
    path: apps/web/src/components/chat/feed-model.test.ts
---

# Chat Stream Composition

## Turn structure

**Capability statement**: The chat feed MUST draw every assistant turn as one
persistent structure whose regions are placed by a pure plan of the turn's
parts (`composeTurn` in the kit, `turnLayout` in buildd), not by the order the
stream delivered them, so the reader sees one conversation revealed
progressively rather than pieces loading independently.

A turn's regions, top to bottom (`ChatThread compose="turn"`):

```
┌ head ─────────── avatar · name · time        drawn from the first chunk
├ work line ────── live step → "Writing the answer" → "Did 6 steps · filed 1 task"
├ tool rows ────── only while the folded line is opened
├ phase "answer"
│   answer slot ── the phase's latest prose, replaced in place (answerPartIndex)
│   blocks ─────── hand-offs, custom rows, deferred steers
│   closing card ─ the approval card (or card of rows) that ended the phase + its receipt
│   results ────── Created groups, then one Referenced group; mounted once settled
├ phase "answer@<i>"  opened by the decision or steer at part i
│   answer slot ── the reply to the decision: a NEW node below the card
│   …
├ turn error
└ footer ───────── a directive to save, the thumbs
```

A **phase** is a run of parts ended by an approval run or an applied steer.
Its key is `answer` for the first phase and `answer@<index>` after the
boundary at part `index`; parts only append, so a key never changes. A phase
is **settled** once it is closed or the turn stopped streaming; its results
are drawn only then, so a card never mounts above prose that is still
arriving and then gets pushed down by it.

**Invariants**:
- A new part MUST NOT change an earlier phase's range, answer index or key.
- A turn's answer slot for a phase MUST be one keyed node from its first
  prose to settle; a later, longer text part replaces its content, never a
  second node.
- A short streaming text part (fewer than `ANSWER_SWAP_MIN_CHARS` characters and no
  finished sentence) MUST NOT replace earlier prose, so the slot never blanks.
- The reply after Confirm or Discard MUST be the next phase's answer, below
  the card; the rationale above the card MUST stay the same DOM node, in the
  same parent.
- Results of a phase MUST NOT render before the phase is settled.
- The head and the 40px indent MUST be the same while streaming and settled.
- A turn with steps MUST keep its work line filled from the first step until
  it becomes the folded line (`holdLine`); the live line and folded line MUST
  have the same height at each breakpoint.

**Acceptance criteria**:
- AC-1: GIVEN a turn that streams interim prose, runs a read and a write, then
  streams a longer final answer WHEN each frame renders THEN exactly one
  `kit-answer` node exists in the turn and it is the same node in every frame.
- AC-2: GIVEN the same turn WHEN any frame before the last renders THEN no
  object card exists in the turn.
- AC-3: GIVEN a settled turn WHEN it renders THEN its result groups follow its
  answer in document order.
- AC-4: GIVEN an approval card with rationale above it WHEN the decision's
  reply streams THEN the rationale node, the card node and their order are
  unchanged and a second `kit-answer` node exists after the card, `aria-busy`
  while live.
- AC-5: GIVEN a phase closed by an approval WHEN its parts after the card
  arrive (a read, then prose) THEN the closed phase's range and results are
  identical to before.
- AC-6: GIVEN an interrupted turn (a cut-off stub then a turn error) WHEN it
  renders THEN the answer slot shows the last useful prose, not the stub, and
  the error renders after the last phase.

## Result groups

**Capability statement**: Every object card in a turn MUST belong to a group
that says what it is and why it is there, adjacent to the text it supports;
proximity alone MUST NOT imply a relationship.

- **Created** (`kind: 'created'`): one group per write call, holding every
  object that write returned, labelled with the verb and count
  ("Created · 2 tasks", "Updated · 1 mission").
- **Referenced** (`kind: 'referenced'`): one group per phase for what its reads
  returned. A read's object is cited as a card when the read fetched one
  thing, when it is a PR, or when the phase's answer names it (id, short id or
  a title of at least 12 characters); cited cards follow the order the answer
  names them. The rest of a list folds into one "Also read" row inside the
  group; a group with nothing cited is just that row.
- **Receipt**: what an approved write filed renders under its card, inside the
  action block.

**Invariants**:
- Each object MUST be drawn at most once per turn, at its first place in
  phase order: the phase's writes, its reads, then its closing card.
- A decision MUST NOT take an object back from a group its phase already
  shows; the receipt shows only what is new.
- The same parts MUST produce the same layout (reload, reconnect).
- Event messages keep their own segments (`feedSegments`); they are not turns.

**Acceptance criteria**:
- AC-7: GIVEN one get read and a prose answer WHEN laid out THEN the phase has
  one Referenced group with that object.
- AC-8: GIVEN a list read of ten where the answer names two titles WHEN laid
  out THEN the two are cards in the answer's order and the other eight are
  the folded row.
- AC-9: GIVEN a write returning two objects and a read WHEN laid out THEN the
  groups are Created (2) then Referenced (1).
- AC-10: GIVEN a write and a read returning the same object WHEN laid out THEN
  it is drawn once, under Created.
- AC-11: GIVEN the same parts rendered twice WHEN compared THEN every group and
  card is the same DOM node, none added or removed.

## Reading position

**Capability statement**: The thread MUST move the viewport only when the
reader is following the live turn or has just answered a card; otherwise the
block the reader is on MUST keep its viewport offset.

`Follow` modes in `ChatWorkspace`: `bottom` (follow the stream), `free` (the
reader scrolled away), `anchor` (a line held `ANCHOR_GAP` below the top: the
reply after Confirm/Discard, or the head of a finished reply taller than the
view). In `free`, `readerBlock` picks the first message reaching below the
scroller's top, then descends through its phases and results to the finest
region that does; any layout change pays the drift back in `scrollTop`. The
scroller sets `overflow-anchor: none` so the browser does not correct a
second time.

**Invariants**:
- In `free`, content growing above the reader's block MUST NOT change its
  offset from the scroller's top by more than 1px.
- In `free`, content growing below the reader MUST NOT change `scrollTop`.
- A turn landing while the reader is in `free` MUST NOT scroll to the bottom.

**Acceptance criteria**:
- AC-12: GIVEN the reader scrolled to 900 with their block at 800 WHEN 200px
  are inserted above it THEN `scrollTop` is 1100.
- AC-13: GIVEN the reader scrolled away WHEN content grows below them THEN
  `scrollTop` is unchanged.
- AC-14: GIVEN Confirm WHEN the reply streams THEN `scrollTop` puts the reply's
  first line `ANCHOR_GAP` below the top and holds it there while it streams.
- AC-15: GIVEN a scroller WHEN rendered THEN it carries `overflow-anchor: none`.

## Storyboard

The dev fixtures page plays these frames (`/app/dev/chat?state=composed`,
`&frame=N` holds one; Confirm on `?state=propose` plays the resume).

```
frame 0  head │ ■ (square)         │ "The rates service needs a follow-up…"▌
frame 1  head │ ■ Reading a task   │ "The rates service needs a follow-up…"
frame 2  head │ ■ Drafting a task  │ "…"                     (nothing below)
frame 3  head │ ■ Writing the answer│ "…"
frame 4  head │ ■ Writing the answer│ "Nothing covered stale rates, so I…"▌   same node
frame 5  head │ ▭ Did 2 steps · filed 1 task │ final answer
              │ ┃ CREATED · 1 task      [task shell → card, same height]
              │ ┃ REFERENCED · 1 task   [task shell → card]

resume   head │ ▭ fold │ "Here's a draft."         ← rationale, same node
              │ [ New mission · Confirm & file ]   ← card, same node
              │ [ mission receipt ]
              │ "Filed. buildd is planning it…"▌   ← new answer node, view anchored here
```

## Trade-offs

- Results wait for their phase to settle. A card is never shown above prose
  that will push it down, at the cost of seeing a write's card only when the
  turn lands; while the turn works, the pinned key step names the write in
  words.
- The rationale above an approval stays visible after the decision. It is the
  context of the card; the reply below it is the turn's settled answer
  (`answerText` reads the last phase).
- The head and indent are drawn while streaming, trading the earlier bare
  live line for a frame that never reflows when the turn lands.
- Tool rows sit under the work line, not between prose and cards: they are
  history, unfolded on request.

**Code surface**:
- `packages/ai-kit/src/chat/react/model.ts`: `composeTurn`, `TurnPhase`.
- `packages/ai-kit/src/chat/react/Thread.tsx`: `ChatThread` `compose="turn"`, `renderPhaseResults`.
- `packages/ai-kit/src/chat/react/cards.tsx`: `ThinkingPanel` `holdLine`.
- `apps/web/src/components/chat/feed-model.ts`: `turnLayout`, `shownRefs`, `feedSegments` (events).
- `apps/web/src/components/chat/objects/registry.tsx`: `ResultGroupView`.
- `apps/web/src/components/chat/ChatFeed.tsx`: the slots.
- `apps/web/src/components/chat/ChatWorkspace.tsx`: `Follow`, `readerBlock`, `ANCHOR_GAP`.
- `apps/web/src/app/globals.css`: "Thread on the kit".

**Out of scope**: the object cards' own content and live refresh, the composer,
the docked pane and phone sheet, and event messages (`role: 'event'`).
