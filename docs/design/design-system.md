---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "type-scale-tokens"
    type: "config_key"
    key: "type-chip"
    file: "apps/web/src/app/globals.css"
  - id: "chip-primitive"
    type: "symbol"
    name: "Chip"
    path: "apps/web/src/components/ui/Chip.tsx"
  - id: "mobile-type-floor-test"
    type: "test_file"
    path: "apps/web/src/app/mobile-type-floor.test.ts"
  - id: "design-drift-check-tests"
    type: "test_file"
    path: "scripts/design-check.test.ts"
---

# Design System

**Status:** Implemented (tokens describe what ships; the §3 type scale and the §4 primitives are built)
**Related:** `apps/web/src/app/globals.css`, `apps/web/tailwind.config.ts`, `apps/web/src/app/mobile-type-floor.test.ts`, `apps/web/src/components/BottomSheet.tsx`, `apps/web/src/components/ui/StatePill.tsx`, `apps/web/src/components/ui/states.ts`, `apps/web/src/app/app/(protected)/settings/workspace/[workspaceId]/ReleaseSection.tsx`, `docs/design/mobile-feed-spec.md` (mobile layout), `knowledge-base: buildd/design/chat-canvas.md` (chat-specific geometry and tokens), `knowledge-base: buildd/plans/ios-app-mvp.md` (iOS tokens), `.claude/skills/ui_designer/`

**This is the one design reference.** Read this file before writing UI. The
`ui_designer` skill, its `references/` files and `mobile-feed-spec.md` point here
instead of carrying their own token tables.

---

## Problem

Four documents described the design system and none of them matched the code:

- `docs/design/mobile-feed-spec.md` §1 gave a token table with values the app
  never shipped (a `#101216` ink, a `#f4f3ee` paper, 1.5px borders), and its
  prose still calls the accent copper `#c8956a` while the table says `#f4811f`.
- `.claude/skills/ui_designer/` carried a second token table (`--text-muted`
  `#5e5850`, light `--status-error` `#c0524a`) and a 359-line
  `references/components.md` that predates the button, pill and sheet classes
  now in `globals.css`.
- `knowledge-base: buildd/plans/ios-app-mvp.md` defers to mobile-feed-spec and so ships a teal
  accent the web app does not have.

The code drifted in the same way. Three components render a status chip three
different ways (`StatusBadge`, `HeartbeatStatusBadge`, and a local
`StatusBadge` in `ReleaseSection.tsx`); `StatusBadge` reaches for a raw
`#D97706`. Four surfaces still hand-roll a bottom sheet next to the shared
`BottomSheet`. Pages size text with arbitrary `text-[Npx]` values: more than
twenty distinct sizes are in use, including half-pixel ones (`10.5px`,
`11.5px`, `12.5px`, `13.5px`), and the mobile/desktop pairs vary page by page
(`text-[11px] md:text-[10px]`, `md:text-[10.5px]`, `md:text-[9px]`,
`md:text-[8px]` all coexist).

## Proposal

**The crux: the code is the source of truth and this doc only explains it.**
`globals.css` CSS variables and `tailwind.config.ts` are executable; a doc table
is not. Every token below is read from those two files. Where an older doc
disagrees, the code value is recorded here, never resolved by editing this doc to match the older one. If this doc
and `globals.css` ever disagree, `globals.css` wins and this doc is the bug.

On top of the tokens sit a fixed type scale (§3) and a small primitive layer
(§4), both in code: `--type-*` in `globals.css` and the components in
`apps/web/src/components/ui/`.

---

## 1. Direction

**Refined: quiet by default, strong when something matters.** Most of a page
is hairlines and whitespace; weight is spent only where the reader has to look
or act. The rules below apply to every page; §2 records the executable tokens
and classes.

- **Three emphasis levels.**
  - **L1, most of the UI:** 1px warm hairlines (`--border`) and whitespace. No
    frame where spacing already separates things.
  - **L2, the focused card:** a `.card` (1px `--border` frame on `--card`).
    When it is the selected or focused one, the frame becomes 1.5px
    `--text-primary` (the ink).
  - **L3, genuine decisions only:** a 1.5px `--dec-frame` (orange) frame on
    `--inset`, with a charcoal primary button (`--text-primary` fill,
    `--on-ink` text). A passive card with a link is never L3.
- **Three radii.** 3px strip cells, 4px pills and controls, 6px cards
  (`--radius-cell`, `--radius-pill`, `--radius-card`). There is no circle.
- **No shadows.** Depth comes from the surface steps and hairlines, never an
  offset or a blur.
- **Voice, UI and data have different type.** Newsreader is Buildd's voice,
  Schibsted Grotesk is the UI and titles, JetBrains Mono is counts, IDs and
  lifecycle (§1.1).
- **One accent.** Orange means action, a decision or live work. State hues
  mean state. Nothing coloured is decorative.
- **Contrast is tested.** Every text token is at least 4.5:1 on every surface,
  in both themes; `--faint` is for graphics only (at least 3:1). No text is
  lighter than `--text-muted`. `globals-contrast.test.ts` computes it.
- **Two themes.** Night (warm charcoal, the default) and Day (warm linen),
  switched with `[data-theme]`. Components use tokens only, so both work.

### 1.1 Voice and fleet objects

**The crux is the two materials, on every page.** Buildd speaks in a human
voice; the fleet is made of plain, exact objects. This is a general
composition rule, including Home, detail pages and chat.

- **Voice:** when Buildd speaks to the user, use Newsreader (`.font-voice`).
  This includes a page's headline sentence ("2 decisions need you."), its
  italic sub-line and agent messages. Use sentence case. A named page or
  object title is not voice; a sentence addressing the reader is.
- **Fleet objects:** tasks, missions, PRs, questions and approval cards are
  objects. Their titles and descriptive sentences are Schibsted Grotesk (the
  default `font-sans`); their counts, IDs, SHAs, durations and lifecycle words
  are JetBrains Mono (`font-mono`). An object is an L2 card or an L1 row, and
  an L3 decision when, and only when, it asks the user to decide.
- **Orange:** reserve it for decisions and live work: a decision frame, a
  needs-you count, a live indicator, the chat send control. Never a button
  fill and never a selected state. The primary action is ink (`.btn-primary`,
  `PrimaryAction`), on cards and decision cards alike. State labels
  use their state hue or ink, never orange: a mission label is ink, a stalled
  one uses `--status-error` or `--status-warning`.
- **Labels:** no all-caps tracked labels in product UI. Section headers are a
  quiet sans label (`Eyebrow`, `.section-label`); chips, state words,
  statistics and object metadata use sentence case or lowercase. Only
  `display` type may be uppercase.

The §2 tables describe what ships, including classes the shared-components
work has not moved yet; a leftover 2px frame or uppercase chip in a component
is not a prescription for new work.

**Chat-specific exceptions.** Bubble radius, the soft sea, composer geometry
and chat tokens (`--chat-*`, `--mood-*`, `--sea-*`, `--kit-*`) stay in
`knowledge-base: buildd/design/chat-canvas.md`. Chat still reads IBM Plex Sans
(`.font-convo`) and IBM Plex Mono (`--kit-font-mono`) until it moves onto the
app's type; those two faces are loaded only for it and retire then. They do not
grant other pages rounded fleet objects or blurred shadows. The public
[chat-canvas pointer](chat-canvas.md) links back to this general rule.

**iOS.** The native app's `Theme.swift` table in `knowledge-base: buildd/plans/ios-app-mvp.md` is
meant to mirror these tokens. Today it mirrors the old brutalist values. When
the iOS theme is next touched, copy from §2 here.

---

## 2. Tokens (read from `globals.css`)

Tailwind class in brackets where one exists. Night is `:root` /
`[data-theme="dark"]`; Day is `[data-theme="light"]`. The approved refined-UI
prototype names its tokens differently; the last column of each table gives
that name, so a prototype value can be found here.

### 2.1 Surfaces

| Token | Night | Day | Tailwind | Use | Prototype |
|---|---|---|---|---|---|
| `--surface-1` | `#1a1816` | `#f7f5f0` | `bg-surface-1` | Page background | `ground` |
| `--surface-2` | `#221f1c` | `#fdfcf9` | `bg-surface-2` | Raised panels, sheets, popovers | `card` |
| `--surface-3` | `#26221e` | `#f2efe9` | `bg-surface-3` | Inset panels, button hover | `inset` |
| `--surface-4` | `#2f2c28` | `#eeebe4` | `bg-surface-4` | Highest step: active filter, tooltip | `q-tint` (solid) |
| `--card` | `#221f1c` | `#fdfcf9` | `bg-card` | L2 card fill | `card` |
| `--card-hover` | `#26221e` | `#f2efe9` | `bg-card-hover` | Interactive card hover | `inset` |
| `--card-finding` | `#26221e` | `#f2efe9` | `bg-card-finding` | Finding cards | `inset` |
| `--card-rightnow` | `#1a1816` | `#f7f5f0` | `bg-card-rightnow` | "Right now" cards | `ground` |
| `--inset` | `#26221e` | `#f2efe9` | `bg-[var(--inset)]` | L3 decision fill | `inset` |
| `--card-border` | `rgba(255,245,230,0.10)` | `#e3ded5` | `border-card-border` | Card edge (= `--border`) | `line` |
| `--chrome-bg` | `rgba(26,24,22,0.92)` | `rgba(247,245,240,0.92)` | — | Header / bottom nav | |
| `--chrome-sidebar` | `#15130f` | `#f7f5f0` | — | Sidebar rail | |

### 2.2 Text

Two levels: ink and sub. The four older names stay so components keep working;
the three below ink all resolve to `--sub` and are the floor for text.

| Token | Night | Day | Tailwind | Use | Prototype |
|---|---|---|---|---|---|
| `--text-primary` | `#ede8e2` | `#26231f` | `text-text-primary` | Titles, body; the focused-card frame and the primary button fill | `ink` |
| `--text-secondary` | `#a89f96` | `#6b655c` | `text-text-secondary` | Secondary body | `sub` |
| `--text-desc` | `#a89f96` | `#6b655c` | `text-text-desc` | Descriptions | `sub` |
| `--text-muted` | `#a89f96` | `#6b655c` | `text-text-muted` | Meta, timestamps, captions. The lightest text allowed | `sub` |
| `--on-ink` | `#1a1816` | `#fdfcf9` | `text-[var(--on-ink)]` | Text on an ink fill (the charcoal button) | `on-ink` |
| `--faint` | `#7a7269` | `#8f887d` | — | **Graphics only:** strip outlines, idle marks. Never text | `faint` |

### 2.3 Borders

| Token | Night | Day | Tailwind | Use | Prototype |
|---|---|---|---|---|---|
| `--border` | `rgba(255,245,230,0.10)` | `#e3ded5` | `border-border-default` | 1px hairline; the `.card` frame | `line` |
| `--line-soft` | `rgba(255,245,230,0.07)` | `#eae5dc` | `border-[var(--line-soft)]` | Hairline inside a card (row dividers, `.inset-panel`) | `line-soft` |
| `--border-strong` | `rgba(255,245,230,0.22)` | `#cfc8bc` | `border-border-strong` | Control border: inputs, `.btn`, pills, `.seg` | `line-strong` |

### 2.4 Accent and decisions

| Token | Night | Day | Tailwind | Use | Prototype |
|---|---|---|---|---|---|
| `--accent` / `--primary` | `#f4811f` | `#e07a2e` | `bg-accent`, `bg-primary` | The one accent fill: send, live, progress, needs-you. Never a button fill | `act-fill` |
| `--primary-hover` | `#d96e12` | `#c2611f` | `bg-primary-hover` | Accent fill hover | |
| `--accent-soft` | `rgba(244,129,31,0.12)` | `#faeadb` | `bg-accent-soft` | Accent tint behind accent text | `act-tint` |
| `--primary-subtle` | `rgba(244,129,31,0.10)` | `rgba(224,122,46,0.10)` | `bg-primary-subtle` | Faint accent fill | |
| `--primary-ring` | `rgba(244,129,31,0.30)` | `rgba(224,122,46,0.28)` | `ring-primary-ring` | Focus ring tint | |
| `--accent-text` | `#f59b4e` | `#9a4a12` | `text-accent-text` | **Accent as text.** The fill colour fails small-text contrast on Day | `act` |
| `--accent-deep` | `#f59b4e` | `#9a4a12` | — | Same as `--accent-text` (kept for old call sites) | `act` |
| `--on-accent` | `#1a1512` | `#1a1512` | — | Ink on an accent fill | |
| `--dec-frame` | `#f4811f` | `#c2611f` | `border-[var(--dec-frame)]` | L3: the 1.5px decision frame | `dec-frame` |
| `--dec-hover` | `#f7b57a` | `#7f3c11` | — | L3: hover on the decision's action text | `dec-hover` |
| `--accent-shadow` | `none` | `none` | `shadow-[var(--accent-shadow)]` | Retired hero shadow (resolves to nothing) | |

### 2.5 State hues, tints and hatches

| Token | Night | Day | Tailwind | Meaning | Prototype |
|---|---|---|---|---|---|
| `--status-success` | `#86c99d` | `#2f6440` | `*-status-success` | Landed, done, healthy | `ok` |
| `--status-info` | `#93b8d6` | `#2d5a7c` | `*-status-info` | Auditing, in review; informational | `run` |
| `--status-running` | `#f59b4e` | `#9a4a12` | `*-status-running` | Live work (the accent hue, text-safe) | `act` |
| `--status-warning` | `#f59b4e` | `#a9521a` | `*-status-warning` | Needs you, waiting on a decision | `dec` |
| `--status-error` | `#e08a7f` | `#97391f` | `*-status-error` | Failed, blocked, not landed | `bad` |
| `--q` | `#a89f96` | `#5f594f` | `text-[var(--q)]` | Queued, ready, idle | `q` |

Each hue has a tint for the chip or cell behind it, all at least 4.5:1 against
their hue: `--ok-tint`, `--run-tint`, `--accent-soft`, `--bad-tint`, `--q-tint`
(night `rgba` over the card, day solid: `#e6efe7`, `#e4ecf2`, `#faeadb`,
`#f6e5df`, `#eeebe4`). A landed strip cell is `--ok-cell` (`#3d5a47` /
`#b9d2bf`). The hatches mark a share of a strip that is in audit or queued, never
decoration: `--ok-hatch` (`#5e8f6d` / `#8db89a`), `--run-hatch` (`#4f7896` /
`#7fa3c0`), `--act-hatch` (`#a5612c` / `#e6a774`). The fleet aliases
`--fleet-ok-soft`, `--fleet-err-soft` and `--fleet-faint` now read `--ok-tint`,
`--bad-tint` and `--faint`.

State colours go on chips, cells, glyphs, left borders and text. Never as the
fill of a button, card or page.

`--cat-*` (task type: bug, feature, refactor, chore, docs, test, infra,
design, research, as `*-cat-<name>`) are unchanged, in both themes. Chips and
dots only.

### 2.6 Geometry, borders, shadows, layers

| Property | Value (code) | Where |
|---|---|---|
| Radius | `--radius-cell` **3px** (Tailwind `sm`), `--radius-pill` **4px** (`DEFAULT`, `md`, `full`), `--radius-card` **6px** (`lg`, `xl`, `2xl`, `3xl`). `none` is 0 | `globals.css`, `tailwind.config.ts`; guarded by `radius-scale.test.ts` |
| Card frame | **1px** `--border`, 6px radius; focused card **1.5px** `--text-primary`; decision **1.5px** `--dec-frame` on `--inset` | `.card` |
| Control border | **1px** `--border-strong`, 4px radius | inputs/textareas/selects (forced `!important`), `.btn`, `.status-pill`, `.health-pill`, `.control-radio/.control-check` (3px) |
| Hairlines | **1px** `--border`, or `--line-soft` inside a card | `.inset-panel`, row dividers, the chosen `.seg-item`'s ring |
| Segmented | `--q-tint` trough, 6px radius, 3px inset, no frame; chosen option on `--card`, ink, 1px ring. Never orange | `.seg` / `.seg-item-active`, `components/ui/Segmented.tsx`; guarded by `chrome-refinement.test.ts` |
| Shadows | **None.** `--card-shadow` and `--accent-shadow` are `none`; every Tailwind `boxShadow` step is `none` | `globals.css`, `tailwind.config.ts`; guarded by `card-shadow.test.ts` |
| Focus | `2px solid var(--accent)`, offset 2px | `:focus-visible` |
| Touch target | ≥ 44px on mobile | follow `BottomSheet` close button (`w-11 h-11`) |
| Button heights | `.btn-sm` 24 · `.btn` 32 · `.btn-lg` 40 | `globals.css` |
| Z-index | 10 mobile header · 20 bottom nav · 30 sidebar backdrop · 40 sidebar panel · 50 modals, sheets, dropdowns | comment at the top of `globals.css` |

Radius exceptions that ship today are all chat: bubbles (`--kit-radius-soft`
18px), the sea pools, the thread's error note and the steer composer. Arbitrary
`rounded-[…]` values elsewhere must be on the scale; `radius-scale.test.ts` lists
the chat selectors it skips.

**Spacing.** There are no custom spacing tokens. Use Tailwind's default 4px
scale. Recurring values worth matching: card/inset padding `10px 12px`
(`.inset-panel`, `.notice`), button padding `0 12px` (`.btn`), chip padding
`3px 8px` (`.status-pill`).

### 2.7 Fonts and the existing type classes

| Family | Variable | Role |
|---|---|---|
| Schibsted Grotesk 400/500/600/700 | `--font-schibsted` (`--font-sans`, Tailwind `font-sans`, `font-display`) | Default UI, titles, object sentences |
| JetBrains Mono 400/500/600 | `--font-jetbrains-mono` (`--font-mono`, Tailwind `font-mono`) | Counts, IDs, SHAs, durations, lifecycle |
| Newsreader | `--font-newsreader` | Buildd speaking to the user on any page (`.font-voice`) |
| IBM Plex Sans, IBM Plex Mono | `--font-plex-sans`, `--font-ibm-plex-mono` | Retiring: loaded only for chat (`.font-convo`, `--kit-font-mono`) |
| Outfit | `--font-outfit` | Loaded; long-form markdown |
| Fraunces | `--font-fraunces` | Loaded; marketing only, never product UI |

Type classes in `globals.css`: `.section-label` and `.section-label-missions`
(sans, `--type-eyebrow` 13px/600, `--text-muted`), `.field-label` (sans, 12px/600),
`.btn` (sans, 12px/600), `.seg-item` (sans, 13px/500, 600 when chosen);
`.type-label` (mono, 10px/500), `.health-pill` and `.status-pill` (mono,
11px/600), the lifecycle words. None of them is uppercase or tracked
(`chrome-refinement.test.ts`). Below `md` every one of the sub-11px
classes is lifted to 11px (**the mobile type floor**, guarded by
`mobile-type-floor.test.ts`). Form fields render at 16px below `md` so iOS
Safari does not zoom.

### 2.8 Retired (brutalist values this palette replaced)

| Was | Now |
|---|---|
| Radius 0 everywhere, `full` included | 3 / 4 / 6px scale; `full` is the 4px pill |
| Hard offset shadows (`--card-shadow` `5px 5px 0 0`, the `2,2`…`9,9` Tailwind scale) | No shadows |
| 2px `--border-strong` ink frames on cards, buttons, inputs | 1px `--border` card frame; 1px `--border-strong` controls |
| IBM Plex Mono for all UI | Schibsted Grotesk UI, JetBrains Mono data |
| Day `--accent` `#f4811f` | `#e07a2e` (Night unchanged) |
| `--status-warning` ochre (`#e0b35a` / `#9a7a20`) | The decision orange (`#f59b4e` / `#a9521a`) |
| Four text greys | Ink and sub |
| `.filter-pill` hover/active hard-coded night `rgba(255,245,230,…)` | `--q-tint` / `--surface-4`, both themes |


---

## 3. Type scale

One fixed set of roles replaces per-page `text-[Npx]` and `text-[Npx] md:text-[Npx]`
pairs. Mobile is below `md` (48rem); desktop is `md` and up. Sizes are chosen
from the values the app already uses most (`11px` and the `11 → 10` pair dominate
by a wide margin) so most call sites move by 0–1px. Nothing on mobile is under
11px.

| Role | Mobile | Desktop | Weight | Case / tracking | Line height | Use |
|---|---|---|---|---|---|---|
| `chip` | 12 | 11 | 600 | sentence / lowercase, normal | 1 | Status chips, pills, tags (= `.status-pill`) |
| `eyebrow` | 13 | 13 | 600 | sentence, normal; sans, `--text-muted` in a Section | 1.2 | Section header only (= `.section-label`) |
| `meta` | 12 | 12 | 400 | sentence | 1.4 | Timestamps, `role · model`, counts, captions. `--text-muted` |
| `body` | 13 | 13 | 400 | sentence | 1.5 | Default UI text, rows, descriptions |
| `title` | 14 | 14 | 600 | sentence | 1.35 | Card, row and sheet titles |
| `lede` | 16 | 15 | 400 | sentence | 1.45 | The one plain-language sentence under a page or card title (§5) |
| `heading` | 20 | 24 | 700 | sentence | 1.25 | Page `h1` (today `text-xl md:text-2xl font-bold`) |
| `display` | 28 | 40 | 700 | UPPERCASE allowed | 1.1 | Mastheads and hero numbers only |

Implementation: one CSS variable per role in `globals.css` (`--type-chip: 11px`,
overridden in an `@media (width >= 48rem)` block), exposed as Tailwind
`fontSize` entries in `tailwind.config.ts` (`text-chip`, `text-eyebrow`,
`text-meta`, `text-body`, `text-title`, `text-lede`, `text-heading`,
`text-display`) so a call site writes one class, not a breakpoint pair. The
classes carry size and line height only; weight, case and tracking stay on the
call site (or in the primitive). The primitives in §4 consume these roles; new code should not
add `text-[Npx]`. Glyph-only sizes (disclosure chevrons, the desktop rail) keep
their exemptions in `mobile-type-floor.test.ts`.

---

## 4. Primitive inventory

All seven are built in `apps/web/src/components/ui/` (`Chip`, `Eyebrow`,
`Section`, `Lede`, `PrimaryAction`, `Disclosure`, `Sheet`), each with a unit or
DOM test beside it. Only `Chip` and `Sheet` have been swapped in so far; the
**Replaces** lists of the other five are follow-up migrations. `Card` and
`Notice` (below) are built the same way; so far only the planning-task status
on the task page renders `Notice`, the rest of their **Replaces** lists are
follow-ups too.

Location: `apps/web/src/components/ui/`, next to `Dialog`, `Select`,
`Combobox`, `Switch`. Tokens only, no raw hex, no `text-[Npx]`, square chrome,
touch targets ≥ 44px on mobile.

### Chip

**Purpose:** the one way to show a state word. 1px border on the 4px pill
radius, mono in sentence case or lowercase, optional leading square dot. Existing uppercase
styles are recorded in §2.7; new composition follows §1.1.

**Built:** `components/ui/Chip.tsx`.

**Props:** `tone: 'success' | 'running' | 'warning' | 'error' | 'info' | 'accent' | 'muted'`,
`variant?: 'outline' (default) | 'soft' | 'solid'`, `dot?: boolean` (default true),
`pulse?: boolean` (live states), `children`, `trailing?: ReactNode` (a muted suffix such as `3m`),
`className?`, `data-testid` passthrough.

**Replaced for state words by `StatePill`** (below). `StatusBadge`,
`HeartbeatStatusBadge` and `ReleaseSection`'s local badges now render
`StatePill`; `Chip` stays for tags that are not a state.

Later candidates (not the next task's scope): `StageChip.tsx`, `LoopStatusChip`, and the `.health-pill` /
`.status-pill` classes themselves.

### StatePill and the state table

**Purpose:** a state as glyph + word (`◐ Auditing`). One table,
`components/ui/states.ts` (`STATES`), feeds the pill, `Lifecycle` and every
strip cell: the strip spec's display states
(`docs/specs/mission-progress-strip-ordering.md` §3.1) plus `landing`,
`recovering`, `not_landed` and `needs_you`. Each state has its own glyph and
its own cell (pattern, frame) pair, so it reads in greyscale
(`states.test.ts`). Cell textures are the `.state-cell` rules in `globals.css`.

**Props:** `state`, `label?` (replaces the word, keeps the glyph),
`variant?: 'tinted' (default) | 'plain'`, `trailing?`, `title?`, `data-testid`.
`StatusPill({ status })` maps a task or worker status (`STATUS_PILL`);
`TonePill({ tone })` is the same pill without a glyph, for fact tags.

### Refined components

All in `components/ui/`, from the refined-UI prototype:

- `Lifecycle`: `Build → Audit → Land` with the current step, and its repair /
  recovering / needs-you variants. It is the only drawing of that track:
  Activity rows and Home's delivery rows (`lifecycleState(kind)` maps a
  delivery kind onto it), the mission drawer (with `notes`, one phrase per
  step) and the task page's run strip (`runLifecycleState` reads the run
  evidence; the nine phases sit behind its "Run evidence" disclosure).
  **Props:** `state`, `repairs?` (`repair N` while repairing, `↻N` for rounds
  already taken), `notes?: [build, audit, land]`, `className?`. Spans only, so
  it can sit inside a link or a button row.
- `TaskStrip`: `size="lg"` is the interactive strip (one button per task,
  ← → / Home / End, tick-row marks per spec §5, a mark never restyles a cell,
  cells capped at 56px on desktop); `size="sm"` replaces progress bars and,
  above 16 tasks, folds runs of merged / ready / blocked / queued into one
  segment sized by count (`task-strip.ts`).
- `FocusCard` (L2) with the SEL-2 reason line (`reasonLine`) and `TimeRow`,
  which renders only when an estimate exists.
- `MissionRow`, `Segmented` (a radio group), `Criteria`.
- L3: `.card-decision` (1.5px `--dec-frame` on `--inset`) and `.btn-ink` (the
  charcoal primary). The Home review cards wear them.

### Card

**Purpose:** the L2 card: one standalone object on a page (a release, a
connector, a revision). Not for a decision (that is L3, `.card-decision` +
`.btn-ink`) and not for a group inside a section (L1: a hairline divider, no
frame).

**Built:** `components/ui/Card.tsx`.

**Props:** `as?` (element or component, default `div`), `padding?: 'sm' | 'md'`
(12px / 16px, default `md`), `interactive?` (a linked card: hover fill and a
2px ink focus ring), `bare?` (no frame, only the padding, for a card nested
in a card), `className?`, and any prop of the element (`href`, `aria-*`,
`data-testid`).

**Look:** the `.card` class: `--card` fill, 1px `--border`, `--radius-card`
(6px), no shadow (`card-shadow.test.ts`). `<Card>` and a hand-written `.card`
are the same card; `.card-interactive` carries the hover and focus states.

**Replaces:** the census's ad-hoc framed boxes: the retired 2px ink frame
(`border-2 border-border-strong`), hairline square or rounded boxes with
padding, and fill-only panels, wherever the box is a standalone object.

### Notice

**Purpose:** the one inline alert: saved, heads up, failed, for your
information. A status line, not a decision; a notice that asks for a person's
call is an L3 decision card instead.

**Built:** `components/ui/Notice.tsx`.

**Props:** `tone?: 'ok' | 'warn' | 'err' | 'info'` (default `info`), `title?`,
`children` (the body), `action?: { label, href } | { label, onClick }` (at most
one), `className?`, `data-testid?`.

**Look:** the `.notice` / `.notice-<tone>` classes: a 1px frame in the tone's
hue on `--radius-card`, text in the same hue, no tint fill (state colours never
fill a card, §2.5). `info` is neutral: `--border-strong` frame, `--text-primary`
text, never orange. The title leads with a glyph per tone (`✓ ! ✕ i`), so the
tone never reads by colour alone. The action is a `.btn .btn-sm`, never a
primary fill. `err` is `role="alert"`; every other tone is `role="status"`.

**Replaces:** tinted alert boxes (`bg-status-*/N border-status-*/N`), 1px
state-hue frames that only report a state, and the bare `.notice` markup.
`.notice-warn` is new; the orange `.notice-info` is now neutral.

### Eyebrow

**Purpose:** the quiet sans section header (type role `eyebrow`), sentence case.
Do not use it for card metadata or status labels (§1.1).

**Props:** `children`, `as?: 'span' | 'p' | 'h2' | 'h3'` (default `span`),
`tone?: 'default' | 'muted' | 'accent'`, `className?`.

**Replaces:** the local `Eyebrow` in `components/chat/objects/parts.tsx`,
ad-hoc `.section-label` spans, and inline
`text-[11px] md:text-[10px] uppercase tracking-…` labels across pages.

### Section

**Purpose:** a titled block on a page: eyebrow heading, optional count and
action on the right, consistent spacing above and below.

**Props:** `title: string` (rendered via `Eyebrow as="h2"`), `count?: number`,
`action?: ReactNode`, `id?`, `children`, `className?`. Renders nothing when
`children` is empty (empty sections collapse; no orphaned headers).

**Replaces:** hand-built section headers (`.section-label` + flex row +
count) on Home, Missions, Health and the settings pages.

### Lede

**Purpose:** the one plain-language sentence that says what a page, card or
sheet is about, written for the owner (type role `lede`, copy rules §5).

**Props:** `children`, `as?: 'p' | 'div'` (default `p`), `className?`.

**Replaces:** per-page summary paragraphs sized `text-[13px]` to `text-[15px]`
under titles, e.g. mission situation lines and settings intros.

### PrimaryAction

**Purpose:** the single most important action on a surface. At most one per
screen or sheet; everything else is `.btn` / `.btn-quiet`.

**Props:** `children`, either `href` (renders a `Link`) or `onClick`,
`type?: 'button' | 'submit'`, `pending?: boolean` (shows the block-ticker
`Spinner` and disables), `disabled?`, `tone?: 'primary' (default) | 'danger'`,
`fullWidthOnMobile?: boolean`.

**Look:** `.btn .btn-primary`, at least 44px tall below `md` (`.btn-lg` is 40px,
so the primitive sets the height), 40px from `md`.

**Replaces:** ad-hoc `bg-primary text-white …` buttons and one-off
`.btn-primary` markup.

### Disclosure

**Purpose:** show/hide a secondary block (details, logs, a long list) without
leaving the page.

**Props:** `summary: ReactNode`, `count?: number`, `defaultOpen?: boolean`,
`open?` + `onOpenChange?` (controlled), `children`, `className?`.

**Behaviour:** a full-width `button` with `aria-expanded` and `aria-controls`,
a rotating chevron glyph, ≥ 44px tall on mobile. Inside a `data-task-id`
subtree the toggle must stop click propagation (see
`docs/specs/timeline-mobile-rail.md`).

**Replaces:** native `<details>`/`<summary>` blocks across app pages and the
hand-rolled chevron toggles in `TaskGrid.tsx` and `CondensedTimeline.tsx`.

### Sheet

**Purpose:** the one modal panel that rises from the bottom on mobile.

**Built:** `components/ui/Sheet.tsx`; `components/BottomSheet.tsx` re-exports it.

**Start from what exists:** `components/BottomSheet.tsx` already is this
primitive (portal to `<body>`, scroll lock on the shell's scroll root,
Escape to close, optional focus trap, `auto`/`tall` heights, a 44px close
button). Move it to `components/ui/Sheet.tsx` and keep `BottomSheet` as a
re-export so its current importers do not change. Add what it lacks: return
focus to the trigger on close (as `FlightDetailSheet.tsx` and
`SwipeableRow.tsx` do), and the 2px `--border-strong` top edge instead of the
1px `--border` it draws now. `SideSheet.tsx` (the docked desktop panel) already
reuses its `lockScroll` and `nextTrappedFocus` helpers and stays separate.

**Props:** as `BottomSheet` had: `open`, `onClose`, `title`, `children`,
`height?: 'auto' | 'tall'`, `handle?`, `trapFocus?`, `flush?`, `lockTarget?`,
`testId?`; plus `width?: 'default' | 'wide'` (`max-w-lg` / `max-w-3xl`, for a
sheet with its own side rail) and `returnFocusRef?` (the trigger to refocus on
close; defaults to whatever was focused when it opened, which Safari leaves on
`<body>` after a click). Focus is only returned if it was lost with the sheet,
never pulled back from somewhere the closing action moved it.

**Replaces (hand-rolled `fixed inset-0` backdrop + bottom panel):**
- `components/MissionPolicyDrawer.tsx`: no dialog role, no `aria-modal`, no
  Escape handling, and a `backdrop-blur-sm` the direction forbids.
- `components/SwipeableRow.tsx` row menu sheet: the best keyboard behaviour of
  the four (focus first item, arrow keys, Escape returns focus to the menu
  button); keep that behaviour when it moves.
- `components/ArtifactViewer.tsx`: full-height viewer with arrow-key paging;
  maps to `height="tall" width="wide"` plus its own arrow-key handler. On
  desktop it is a wide bottom sheet now, not a panel docked right.
- `components/FlightDetailSheet.tsx`: already restores focus; a straight swap.
  Not migrated yet.

The first three are migrated.

`MissionDecisionSheet.tsx` is named in older notes as a hand-rolled sheet; it
now renders inline on the mission page and needs no migration.

---

## 5. Copy rules for owner-facing surfaces

Headline copy (page titles, ledes, chip labels, card titles, sheet titles,
notification text) follows the same rules as a PR lede:

1. **Plain words, said out loud.** Write it the way you would tell a colleague
   what is going on. "Waiting on your approval", not "Gate: human tier pending".
2. **No internals in headlines.** No file paths, routes, endpoints, symbol,
   function, table or column names, and no internal vocabulary (`roleSlug`,
   `waiting_input`). Raw values belong in a detail row or a Disclosure.
3. **No PR or task numbers in the headline.** Link them from meta or a detail
   row; the headline says what happened.
4. **What changed, and why it matters to the reader.** One sentence for a lede.
5. **No em dash** (`—`) in rendered app copy, as a joiner or as an "unknown"
   placeholder; render nothing or a muted value instead
   (`scripts/no-em-dash-copy.test.ts`, `docs/design/derived-metric-availability.md`).
6. **State words come from one vocabulary.** A status reads the same on every
   surface (`STATUS_PILL`'s labels in `components/ui/states.ts`). A task an
   agent can't continue without you reads **Needs input**, never "Waiting on
   you"; a PR you can merge reads **Ready to merge**. Name what is needed, not
   the person. The Home **Needs you** section heading is the one exception.
7. **The UI doesn't explain itself.** Would GitHub, Linear or Claude Code say
   it? A setting gets a label and at most one fact the label can't carry. No
   page blurb restating the title ("Where run evidence is kept"), no "yet" on
   an empty state ("No buckets.", not "No buckets of your own yet."), no
   reassurance ("Nobody can read it back", "Re-enable any time"), no
   justifying a setting, no paragraphs. A toast says what happened: "Codex
   disabled. Jobs run on Claude." The rules are data in
   `packages/core/copy-rules.ts`; **`bun run copy:check`** (CI, a ratchet like
   the design drift check below; `--list` prints every hit) fails on new ones.

---

## Open questions

- **Status tone.** Existing `waiting_on_you → accent` is legacy. New status
  labels use warning or ink; orange belongs to the action or live indicator (§1.1).
- ~~**Desktop `chip` at 10px vs 11px.**~~ Decided: 10px on desktop, 11px below
  md, held in `--type-chip`.
- **`.filter-pill` radius and hard-coded fills.** Lean: square it and move its
  fills to tokens when the Chip lands.
- **iOS `Theme.swift`.** Lean: copy §2 into it on the next iOS task, rather than
  keeping a second table in the plan doc.

## Design drift check

**`bun run design:check`** runs in CI (after `specs:check`) to stop new design debt landing.
It is a **ratchet**: `scripts/design-check.baseline.json` records per-file counts for each rule,
and the check fails only when a rule's total goes UP, so existing debt does not block CI.
It flags five categories in `apps/web/src/`:

1. **Arbitrary font sizes** (`text-[<n>px]`): use a type-scale role (§3).
2. **Raw hex colors** in `className` / `style`: use a design token (§2).
3. **`rounded-full` on chip/badge-like elements** (the same line carries `px-`, `uppercase`,
   `text-xs` or an arbitrary font size): chips take the pill radius from `Chip` (§2.6, §4).
   Avatars and dots are not flagged.
4. **Hand-rolled `fixed inset-0` sheets**: use `Sheet` or `BottomSheet` (§4).
5. **Local `StatusBadge` definitions**: use `StatePill` / `StatusPill` for a state, `Chip` for any other tag.

On failure it prints every violation in the files whose count rose, with file:line and the
section to consult. `components/ui/**` is excluded from all rules; `FlightStrip.tsx` from rules 1–3.

The check fails closed: an unreadable file or unparseable baseline is an error, and in CI a
missing baseline is an error rather than a fresh baseline.

**Updating the baseline.** After paying debt down, run `bun run design:check --update` and commit
the baseline — it lowers counts to today's and never raises them. To deliberately accept new debt
(e.g. reverting a large feature), add `--allow-increase`; reviewers will see the baseline grow.

## Non-goals

- No code changes here; §1.1 defines composition while §2 records shipped tokens.
- The chat canvas's own tokens and rules stay in `knowledge-base: buildd/design/chat-canvas.md`.
- Mobile page layouts (sections, data mapping, the Missions Feed artboard) stay
  in `docs/design/mobile-feed-spec.md`.
