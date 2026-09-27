# Chat canvas

**Status:** Accepted (step 1 implemented; steps 2 and 3 in progress)
**Related:** `docs/design/agent-chat.md`, `apps/web/src/components/chat/ChatWorkspace.tsx`, `apps/web/src/components/chat/objects/PinnedObject.tsx`, `apps/web/src/components/KeyHints.tsx`, `apps/web/src/lib/chat/entry-points.ts`, `apps/web/src/app/api/workers/[id]/instruct/route.ts`

## Problem

Chat reads as one more panel. It lives at `/app/chat`, so asking about the
mission you are looking at means leaving it. Inside, every message has the same
2px ink frame as a mission card, so the conversation and the fleet objects in it
look alike. And the keycaps (1/2 on a question, Esc, the chat shortcut) tell
people who don't write code that this tool isn't for them.

## Proposal

Chat becomes a canvas: a layer you can open over any page, scoped to what you
were looking at, with the live object pinned at the top.

**The crux is the two materials.** The conversation is soft and the fleet is
hard. If that rule slips, one of two things breaks: soft approval cards make
actions look optional, or hard messages make the chat look like the dashboard
again.

- **Conversation (soft):** IBM Plex Sans (`--font-plex-sans`, `.font-convo`),
  tinted bubbles for your messages, open text for the agent, tool rows on a soft
  tint with no frame. Tokens: `--canvas-bg`, `--convo-me`, `--convo-soft`,
  `--convo-line` in `globals.css`. The message bubbles are the one place the
  zero-radius rule bends; the composer and its controls are square (see
  "Mobile canvas" below).
- **Fleet objects (hard):** missions, tasks, PRs, questions and approval cards
  keep square corners and ink borders. An approval gets an orange top edge for
  "needs you" and plain buttons.
- **Orange** still means action or live: the send button, the running tool row,
  and a segment that scans the canvas's top edge while a turn streams
  (`.canvas-scan`, static under `prefers-reduced-motion`).
- **Pinned object:** the object the chat is about (`entry.about`), else the latest
  mission or task in the conversation (`canvasPin` in `feed-model.ts`), pinned at
  the top as a compact board: one column per phase, four rows each, and what
  needs you stays in view. On desktop it hides while the docked pane shows the
  same object.
- **Empty canvas:** a mood line, a hero line and two picked questions
  (`canvas-empty.ts`), described under "Mobile canvas".

### Mobile canvas (v3)

The foreground is square and brutalist: no border radius, 1px rules, offset
shadows. Humanity comes from type, not from rounding: Newsreader
(`--font-newsreader`, `.font-voice`) for anything Buildd or the person says
(the hero, the picked rows, the composer's text and placeholder), IBM Plex Mono
for chrome (labels, counts, scope).

**Colour carries meaning, never decoration.** The roles live in `globals.css`
as CSS variables, in both themes; components never hardcode a hex:
`--chat-ground`, `--chat-bar`, `--chat-surface`, `--chat-raised`,
`--chat-rule`, `--chat-rule-strong`, `--chat-text`, `--chat-muted`,
`--chat-dim`, `--chat-panel`, and the moods `--mood-calm` (teal),
`--mood-needs` / `--mood-needs-fill` / `--on-mood-needs` (copper),
`--mood-thinking` / `--mood-thinking-alt` (blue, violet) and `--mood-landed`
(green). The sea pool colours (`--sea-*`) are defined for the background layer.

**Mood is deterministic.** `canvasMood` reads the viewer's pulse (what waits on
them, and how many agents are at work) from the data the chat page already
loads for its context panel (`canvasPulse` in `chat-shell.tsx`, no extra query):
`needs` when anything waits on the viewer, else `calm`. The summoned canvas
loads no pulse, so it claims no mood and shows the plain greeting.

**Empty canvas** (before the first message):

- **Overline:** mono 11px, `SUN 27 SEP · CALM` or `· NEEDS YOU`, led by an 8px
  square mood dot that breathes in opacity (`.mood-dot`, no glow, static under
  reduced motion).
- **Hero:** Newsreader 44px, then an italic sub-line. Both are templates filled
  from the pulse, never invented: calm reads "All quiet." / "Nothing is waiting
  on you…"; needs-you reads "One thing needs you." and names it. Past the
  loader's limit it says "Several", not a number it doesn't have.
- **PICKED FOR YOU:** a square panel (1px rule, `--chat-panel` so it reads over
  the sea) with a 30px header (label left, "nothing blocked" / "1 blocked"
  right) and exactly two 56px rows: mono `01`/`02`, the question in Newsreader,
  an arrow. Row 1 is copper when it is the thing that needs you. A needs-you
  prompt is never offered when nothing needs you. Questions send in one tap;
  "Start something new" only fills the box. Chats opened about a mission or a
  task keep their own questions under an "ASK ABOUT" header, in the same rows.
- **Placeholder:** the composer's placeholder is the top row.

**Composer:** a full-bleed slab on a phone (a square box on desktop) with a 2px
top rule, copper while something needs you. The text box is at least 64px and
two rows and sizes to its content where the browser can, so the placeholder
wraps instead of clipping. Under it a 48px toolbar of square cells split by
1px rules: scope (grows), tools (56px), tier (at least 72px), send (60px solid
copper block). While a turn streams, send becomes Stop: a light block with a
dark square. Every cell is at least 44px to touch.

Copy is plain language for people who don't write code: "waiting on tests",
not "in CI".

### Keyboard hints

Keycaps are hidden by default everywhere. The shortcuts still work. Settings,
Profile, "Show keyboard hints" (`users.show_keyboard_hints`, `PATCH
/api/me/preferences`) reveals them. Components gate chips with `<Kbd>` and hint
copy with `<KeyHintsOnly>`. Answer and approve options are ordinary buttons.

### Summoning (step 2)

On desktop an "Ask" button floats at the bottom right of every page except chat
itself. ⌘K / Ctrl+K toggles the canvas anywhere, and `c` opens it when the page
has no composer. With hints on, the button also shows the shortcut. "Ask about
this mission/task" opens the canvas too, instead of leaving for `/app/chat`.
The canvas opens over the page with a flat dim (`--canvas-dim`). There is no
blur, and no halftone because it shimmers on some displays. The canvas takes
the page's object as its scope through the same `entry.about` contract
(`canvasScopeFromPath` in `lib/chat/canvas-scope.ts`). A new conversation stays
in the canvas, and opening an object from it navigates the page behind.

- **Phone (below 768px): takes over.** The canvas fills the screen, bottom nav
  included, and ✕ closes it. There is no floating button: the Chat tab and each
  object's own Ask cover it, and a button would sit on the content.
- **Desktop: peeks.** A panel anchored right, up to 600px wide, over a dim that
  still shows the page. The dim, Esc or ✕ close it. "Open full chat" continues
  in `/app/chat/<id>`. Reopening on the same page continues the conversation;
  asking about something else starts a new one.

### Steering (step 3)

The same canvas rescoped to a running agent: crumbs read `Builder @ runner /
task`, and a presence strip under them shows `you ─ buildd ─ runner`, the link
latency, the turn and the current action. Messages go through the existing
steer path (`POST /api/workers/[id]/instruct`, the route behind the task page's
steer box) and land at the agent's next tool boundary.
It opens from task cards and task rows.

## Open questions

- Should the desktop peek remember its open state across navigations? Leaning
  no: a fresh page is a fresh context.
- Halftone dim as an opt-in. Leaning to leave it out until someone asks.

## Non-goals

- Glass and gradient waves (direction 2 of the chat study). The soft sea
  background behind the canvas is the one deliberate exception.
- New shortcuts. This changes who sees the hints, not which keys exist.
- Changing the chat protocol, tools or approvals.
