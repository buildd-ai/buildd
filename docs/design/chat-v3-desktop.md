# Chat v3 on desktop

**Status:** Proposed
**Related:** `docs/design/chat-canvas.md`, `docs/design/mockups/chat-v3-desktop.html`, `apps/web/src/components/chat/ChatWorkspace.tsx`, `apps/web/src/components/chat/ChatCanvas.tsx`, `apps/web/src/components/chat/ChatComposer.tsx`, `apps/web/src/components/chat/canvas-empty.ts`, `apps/web/src/app/app/(protected)/chat/chat-shell.tsx`, `apps/web/src/lib/nav-config.tsx`

## Problem

The approved mobile chat v3 (390x844: square foreground, Newsreader for what
people say, Plex Mono for chrome, the drifting sea, colour that means
something) says nothing about wide screens. Desktop today still has the older
canvas: rounded pills and a rounded composer in `ChatWorkspace.tsx` and
`ChatComposer.tsx`, a pill-shaped floating Ask button in `ChatCanvas.tsx`, an
orange `.canvas-scan` line, and a 400px context aside (`contextAside` in
`chat-shell.tsx`) that repeats what PICKED FOR YOU now says. If desktop is
built from the mobile spec as it stands, the sea gets stretched across 1400px,
the composer turns into a 1300px text box, and nobody has decided where a
docked object goes.

## Proposal

Four frames at 1440x900 are in `docs/design/mockups/chat-v3-desktop.html`,
with PNGs next to it: `chat-v3-desktop-calm.png`, `-needs.png`,
`-thinking.png`, `-peek.png`.

**The crux is one reading column, sized for the text and not the screen.**
Everything Buildd or the user says sits in a 720px column. The sea fills the
width around it, and a fleet object docks beside it. If the column grows with
the viewport instead, Newsreader lines run past 90 characters, the hero looks
lost, and the composer's square cells drift apart until they stop reading as
one toolbar.

### Layout grid

| Zone | Width | Notes |
|---|---|---|
| Rail | 56px | Existing icon rail from `NAV_ITEMS`. Only its colours change: copper active mark. |
| Stage | the rest | Holds the sea and the top bar. Its own layer, clipped. |
| Column | 720px, centred in the stage | Hero, thread, PICKED FOR YOU, composer. Prose max 640px inside it. |
| Dock | 420px, right | Only when there is an object: the thing that needs you, or the mission the chat is about. Opaque. |
| Peek | 600px, 16px inset | The canvas over another page. Opaque, over a dimmed page. |

At 1440 with a dock the stage is 964px, so the column keeps 122px of sea on
each side. Below about 1200px the dock should hand over to the existing
"Open beside" pinned strip (`PinnedObject`) rather than squeeze the column.

### Decisions

- **Sea lives in the stage only.** Nine pools, scaled up for the width (about
  300 to 560px), spread across the whole stage so the column floats on water.
  The dock, top bar and rail are opaque, so the sea never sits behind fleet
  chrome. One sea layer per surface, as on mobile.
- **PICKED FOR YOU stays in the column**, directly above the composer, exactly
  two rows. It does not move to a side panel: the suggestions and the box they
  fill belong together. It replaces the context aside on the empty canvas.
- **Composer is column width, not stage width.** On a phone the column is the
  screen, so "full bleed" there and "column width" here are the same rule. On
  desktop the slab gets a 1px border and a 4px offset shadow so it holds its
  edge over the sea. Toolbar cells keep their order: scope (grows), tools 64,
  tier 88, send or stop 64.
- **Needs you docks the blocker.** When the count is above zero, the task that
  needs you opens in the dock with a copper top edge, what happened in plain
  steps, and two buttons. The hero and row 01 point at the same thing.
- **Thinking keeps the mission docked**, with its LANDED and GOAL strips and
  who is at work. The one glow is the blue segment on the composer's top edge,
  as on mobile. The steps, the caret and the tick squares do not glow.
- **The peek is the mobile mission sheet, turned sideways.** 600px panel, 2px
  top edge, no grabber, over a flat dim that still shows the page shapes. The
  panel itself is opaque and has no sea. Scope is locked to the mission.
- **Landed is green** wherever it appears: segments, the "landed" chip under an
  earlier answer, the dot beside finished work.

### What changes vs today

| Today | v3 desktop |
|---|---|
| Rounded pills for suggestions (`canvas-suggestions`) | Square PICKED FOR YOU panel, two rows |
| Rounded composer and chips, Plex Sans | Square slab, square cells, Newsreader input |
| Orange `.canvas-scan` across the canvas top | Blue segment on the composer top edge, only while busy |
| 400px context aside at `xl` | Gone on the empty canvas. The dock shows a real object instead |
| Docked chat is 540px, object takes the rest | Chat keeps the 720px column. Object dock is 420px |
| Ask button is a rounded pill | Square button; unchanged position |
| Canvas background `--canvas-bg` flat | The sea, behind the column only |

Implementation should add the tokens the mobile spec names (ground, surface,
rule, mood colours) as CSS variables in `globals.css`, shared by both widths.

## Open questions

1. **Should needs you dock the blocker by default?** It makes the empty canvas
   useful at a glance, but it is a second place showing the same thing as
   row 01. I recommend yes, at 1280px and wider, closable, and it stays closed
   for the session once closed.
2. **Composer at column width, or a full-width slab along the bottom of the
   stage?** A slab matches the phone more literally. I recommend column
   width: the cells stay together and the input stays a readable line.
3. **Should the peek carry the sea?** I recommend no. The mobile mission sheet
   is opaque, the page behind already gives it context, and one sea per
   screen keeps it special.
4. **Where does history go?** Today it is a link. I recommend keeping
   `HISTORY →` in the top bar and opening a list in the dock slot, rather than
   adding a permanent left column that pushes the reading column off centre.
5. **Is 720px the right column?** It gives about 70 characters of Newsreader at
   18px. I recommend 720, with prose capped at 640 inside it; 800 if the owner
   wants longer answers to feel less tall.

## Non-goals

- Light theme frames. The tokens need a light pass, but that is its own review.
- Steering presence strip (chat canvas step 3) in the v3 language.
- Any new data. Every string in the frames maps to state the client already
  reads; nothing here needs a new endpoint.
- Mobile. It is approved and unchanged by this doc.
