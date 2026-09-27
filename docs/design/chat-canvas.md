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
  tint with no frame, rounded composer and control chips. Tokens: `--canvas-bg`,
  `--convo-me`, `--convo-soft`, `--convo-line` in `globals.css`. This is the one
  place the zero-radius rule bends.
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
- **Empty canvas:** a greeting in plain words and one-tap questions
  (`canvas-empty.ts`). Questions send right away. "Start something new" only
  fills the box.

### Keyboard hints

Keycaps are hidden by default everywhere. The shortcuts still work. Settings,
Profile, "Show keyboard hints" (`users.show_keyboard_hints`, `PATCH
/api/me/preferences`) reveals them. Components gate chips with `<Kbd>` and hint
copy with `<KeyHintsOnly>`. Answer and approve options are ordinary buttons.

### Summoning (step 2)

An "Ask" button floats on every protected page. With hints on, it also shows the
shortcut. The canvas opens over the page with a flat dim. It never uses blur,
and halftone is off by default because it shimmers on some displays. The canvas
takes the page's object as its scope through the same `entry.about` contract.

- **Phone (below 768px): takes over.** A full-screen sheet. The page behind is
  gone, Back or the handle closes it.
- **Desktop: peeks.** A panel anchored to the right, about 560px wide, over a dim
  that still shows the page. Clicking the dim or pressing Esc closes it. "Open
  full chat" continues in `/app/chat/<id>`.

### Steering (step 3)

The same canvas rescoped to a running agent: crumbs read `Builder @ runner /
task`, and a presence strip under them shows `you ─ buildd ─ runner`, the link
latency, the turn and the current action. Messages go through the existing
steer path (`POST /api/workers/[id]/instruct`, what `send_agent_message` uses) and land at the agent's next tool boundary.
It opens from task cards and task rows.

## Open questions

- Should the desktop peek remember its open state across navigations? Leaning
  no: a fresh page is a fresh context.
- Halftone dim as an opt-in. Leaning to leave it out until someone asks.

## Non-goals

- Glass, orbs, gradient waves (direction 2 of the chat study).
- New shortcuts. This changes who sees the hints, not which keys exist.
- Changing the chat protocol, tools or approvals.
