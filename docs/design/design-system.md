# Design System

**Status:** Accepted (tokens describe what ships; the §3 type scale and the §4 primitives are built)
**Related:** `apps/web/src/app/globals.css`, `apps/web/tailwind.config.ts`, `apps/web/src/app/mobile-type-floor.test.ts`, `apps/web/src/components/BottomSheet.tsx`, `apps/web/src/components/StatusBadge.tsx`, `apps/web/src/app/app/(protected)/missions/[id]/HeartbeatStatusBadge.tsx`, `apps/web/src/app/app/(protected)/workspaces/[id]/config/ReleaseSection.tsx`, `docs/design/mobile-feed-spec.md` (mobile layout), `docs/design/chat-canvas.md` (the one soft surface), `docs/plans/ios-app-mvp.md` (iOS tokens), `.claude/skills/ui_designer/`

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
- `docs/plans/ios-app-mvp.md` defers to mobile-feed-spec and so ships a teal
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
disagrees, the code value is recorded here and the disagreement is listed in
§2.9, never resolved by editing this doc to match the older one. If this doc
and `globals.css` ever disagree, `globals.css` wins and this doc is the bug.

On top of the tokens sit a fixed type scale (§3) and a small primitive layer
(§4), both in code: `--type-*` in `globals.css` and the components in
`apps/web/src/components/ui/`.

---

## 1. Direction

**Brutalist / editorial: "a control room in print. The borders do the
talking."** This is what ships (adopted mid-2026 across the dashboard).

- **Square.** Corner radius is 0. `tailwind.config.ts` zeroes the whole
  `borderRadius` scale, `full` included, so `rounded-*` renders square.
- **Hard shadows.** Every shadow is a solid offset with no blur. The Tailwind
  `boxShadow` scale is redefined as offsets of `var(--border-strong)`.
- **Visible ink borders.** Cards, buttons, inputs and segmented controls carry a
  2px `--border-strong` frame. Hairlines inside them are 1px `--border`.
- **Mono is the voice.** IBM Plex Mono is the body font (`body` in
  `globals.css`, and `sans`/`display`/`mono` in Tailwind all map to it).
- **One accent.** Orange `#f4811f` means action, progress or live. Status
  colours mean state. Nothing coloured is decorative.
- **Two themes.** Night (warm charcoal, the default) and Day (warm linen),
  switched with `[data-theme]`. Components use tokens only, so both work.

**One sanctioned exception: the chat canvas.** The conversation is soft (Plex
Sans, Newsreader for the voice, rounded bubbles via `--kit-radius-soft`, the
blurred "sea"). Fleet objects inside it stay square. See
`docs/design/chat-canvas.md`; the chat tokens (`--chat-*`, `--mood-*`,
`--sea-*`, `--kit-*`) are owned there and not repeated below.

**iOS.** The native app's `Theme.swift` table in `docs/plans/ios-app-mvp.md` is
meant to mirror these tokens. Today it mirrors the old mobile-feed-spec values
instead (teal accent; see §2.9). When the iOS theme is next touched, copy from
§2 here.

---

## 2. Tokens (read from `globals.css`)

Tailwind class in brackets where one exists. Night is `:root` /
`[data-theme="dark"]`; Day is `[data-theme="light"]`.

### 2.1 Surfaces

| Token | Night | Day | Tailwind | Use |
|---|---|---|---|---|
| `--surface-1` | `#1a1816` | `#e7e3db` | `bg-surface-1` | Page background |
| `--surface-2` | `#211f1c` | `#eee9e3` | `bg-surface-2` | Raised panels, sheets |
| `--surface-3` | `#2a2724` | `#e5dfd8` | `bg-surface-3` | Inset panels, button hover |
| `--surface-4` | `#302c28` | `#dbd4cc` | `bg-surface-4` | Deepest inset |
| `--card` | `#2a2724` | `#ffffff` | `bg-card` | Card fill |
| `--card-hover` | `#302c28` | `#fdfcfa` | `bg-card-hover` | Interactive card hover |
| `--card-finding` | `#252220` | `#faf8f5` | `bg-card-finding` | Finding cards |
| `--card-rightnow` | `#1f1d1a` | `#f5f2ee` | `bg-card-rightnow` | "Right now" cards |
| `--card-border` | `rgba(255,245,230,0.06)` | `rgba(0,0,0,0.06)` | `border-card-border` | Faint card edge |
| `--chrome-bg` | `rgba(26,24,22,0.92)` | `rgba(247,244,240,0.92)` | — | Header / bottom nav |
| `--chrome-sidebar` | `#15130f` | `#f7f4f0` | — | Sidebar rail |

### 2.2 Text

| Token | Night | Day | Tailwind | Use |
|---|---|---|---|---|
| `--text-primary` | `#ede8e2` | `#1f1b17` | `text-text-primary` | Titles, body |
| `--text-secondary` | `#a89f96` | `#423c35` | `text-text-secondary` | Secondary body |
| `--text-muted` | `#968e86` | `#6a625a` | `text-text-muted` | Meta, timestamps, captions |
| `--text-desc` | `#9f978e` | `#5f5850` | `text-text-desc` | Descriptions |

### 2.3 Borders

| Token | Night | Day | Tailwind | Use |
|---|---|---|---|---|
| `--border` | `rgba(255,245,230,0.14)` | `rgba(0,0,0,0.42)` | `border-border-default` | 1px hairlines |
| `--border-strong` | `rgba(255,245,230,0.55)` | `#1a1512` | `border-border-strong` | 2px frames; the shadow ink |

### 2.4 Accent

| Token | Night | Day | Tailwind | Use |
|---|---|---|---|---|
| `--accent` / `--primary` | `#f4811f` | `#f4811f` | `bg-accent`, `bg-primary` | The one accent: CTA fill, active, progress |
| `--primary-hover` | `#d96e12` | `#d96e12` | `bg-primary-hover` | Primary hover |
| `--accent-soft` | `rgba(244,129,31,0.14)` | `rgba(244,129,31,0.12)` | `bg-accent-soft` | Accent tint fill |
| `--primary-subtle` | `rgba(244,129,31,0.10)` | `rgba(244,129,31,0.10)` | `bg-primary-subtle` | Faint accent fill |
| `--primary-ring` | `rgba(244,129,31,0.30)` | `rgba(244,129,31,0.28)` | `ring-primary-ring` | Focus ring tint |
| `--accent-text` | `#f59b4e` | `#aa410b` | `text-accent-text` | **Accent as text.** Pure orange fails small-text contrast on Day |
| `--accent-deep` | `#f7a261` | `#b5450c` | — | Deeper accent text |
| `--on-accent` | `#1a1512` | `#1a1512` | — | Ink on an accent fill |
| `--accent-shadow` | `5px 5px 0 0 #f4811f` | `5px 5px 0 0 #1a1512` | — | Hard shadow under an accent-bordered hero |

### 2.5 Status

| Token | Night | Day | Tailwind | Meaning |
|---|---|---|---|---|
| `--status-success` | `#5ec495` | `#3a9864` | `*-status-success` | Done, healthy, landed |
| `--status-running` | `#f4811f` | `#d96e12` | `*-status-running` | Live work (same hue as the accent) |
| `--status-warning` | `#e0b35a` | `#9a7a20` | `*-status-warning` | Waiting, needs attention |
| `--status-error` | `#d97a71` | `#9e3b34` | `*-status-error` | Failed, blocked |
| `--status-info` | `#7aacca` | `#5088b0` | `*-status-info` | Informational only, never an "edit" colour |

Status colours go on chips, dots, left borders and text. Never as the fill of a
button, card or page.

### 2.6 Category (task type)

`--cat-bug`, `--cat-feature`, `--cat-refactor`, `--cat-chore`, `--cat-docs`,
`--cat-test`, `--cat-infra`, `--cat-design`, `--cat-research`
(`*-cat-<name>`), defined for both themes in `globals.css`. Chips and dots only.

### 2.7 Geometry, borders, shadows, layers

| Property | Value (code) | Where |
|---|---|---|
| Radius | **0** for all chrome. Tailwind `none/sm/DEFAULT/md/lg/xl/2xl/3xl/full` all `0` | `tailwind.config.ts` |
| Frame border | **2px** `--border-strong` | `.card`, `.btn`, `.seg`, `.notice`, inputs/textareas/selects (forced `!important`), `.control-radio/.control-check` |
| Hairline / small border | **1px** (`--border` inside, `--border-strong` on pills) | `.status-pill`, `.health-pill`, `.inset-panel`, `.btn-sm`, `.seg-item` dividers |
| Card shadow | `--card-shadow`: `5px 5px 0 0` `rgba(0,0,0,0.55)` night / `rgba(26,21,18,0.95)` day | `.card` |
| Shadow scale | `sm 2,2` · `DEFAULT 3,3` · `md 4,4` · `lg 5,5` · `xl 7,7` · `2xl 9,9` · `inner inset 2,2`, all `0` blur, colour `--border-strong` | `tailwind.config.ts` |
| Focus | `2px solid var(--accent)`, offset 2px, square | `:focus-visible` |
| Touch target | ≥ 44px on mobile | follow `BottomSheet` close button (`w-11 h-11`) |
| Button heights | `.btn-sm` 24 · `.btn` 32 · `.btn-lg` 40 | `globals.css` |
| Z-index | 10 mobile header · 20 bottom nav · 30 sidebar backdrop · 40 sidebar panel · 50 modals, sheets, dropdowns | comment at the top of `globals.css` |

Radius exceptions that ship today: chat bubbles (`--kit-radius-soft` 18px, see
chat-canvas), `.glow-dot` (50%), the sea pools, and `.filter-pill` (`3px`, drift;
see §2.9).

**Spacing.** There are no custom spacing tokens. Use Tailwind's default 4px
scale. Recurring values worth matching: card/inset padding `10px 12px`
(`.inset-panel`, `.notice`), button padding `0 12px` (`.btn`), chip padding
`3px 8px` (`.status-pill`).

### 2.8 Fonts and the existing type classes

| Family | Variable | Role |
|---|---|---|
| IBM Plex Mono 400/500/600/700 | `--font-ibm-plex-mono` | Everything app-owned (the default) |
| IBM Plex Sans | `--font-plex-sans` | Chat conversation (`.font-convo`) |
| Newsreader | `--font-newsreader` | Chat voice (`.font-voice`) |
| Outfit | `--font-outfit` | Loaded; long-form markdown where mono hurts reading |
| Fraunces | `--font-fraunces` | Loaded; marketing only, never product UI |

Type classes already in `globals.css`: `.section-label` (11px/700, uppercase,
2px tracking), `.type-label` (9px/500), `.health-pill` and `.status-pill`
(10px/600, uppercase), `.section-label-missions` (10px/600), `.field-label`
(10px/600, uppercase, 1px tracking). Below `md` every one of the sub-11px
classes is lifted to 11px (**the mobile type floor**, guarded by
`mobile-type-floor.test.ts`). Form fields render at 16px below `md` so iOS
Safari does not zoom.

### 2.9 Disagreements recorded (code value wins)

| Older doc says | Code ships | Source of the older value |
|---|---|---|
| Accent copper `#c8956a` (header and §1 prose) | `#f4811f` | mobile-feed-spec |
| `ink` `#101216` | Day `--text-primary` `#1f1b17`, `--border-strong` `#1a1512` | mobile-feed-spec §1, iOS `Theme.swift` |
| `ink-soft` `#3a414c` | Day `--text-secondary` `#423c35` | mobile-feed-spec §1, iOS |
| `ink-faint` `#6b7280` | Day `--text-muted` `#6a625a` | mobile-feed-spec §1, iOS |
| `paper` `#f4f3ee` | Day `--surface-1` `#e7e3db` | mobile-feed-spec §1, iOS |
| `hair` `#d9d8d0` | Day `--border` `rgba(0,0,0,0.42)` | mobile-feed-spec §1, iOS |
| `accent-deep` = `--accent-text` `#b5450c` | Day `--accent-text` `#aa410b`; `--accent-deep` `#b5450c` (two tokens) | mobile-feed-spec §1 |
| `accent-tint` `#fde7d2`, `accent-border` `#f6c79a`, on-ink `eyebrow`/`sub`/`meta`/`meta-b`/`rule` | No such tokens | mobile-feed-spec §1 |
| `--status-error` `#d4736a` | Night `#d97a71`, Day `#9e3b34` | mobile-feed-spec §1, ui_designer skill (`#d4736a` / `#c0524a`) |
| Status set has four colours | Five: `--status-running` too | mobile-feed-spec §1 |
| Borders 1.5px ink | 2px frames, 1px pills/hairlines | mobile-feed-spec §1, §5 |
| Primary button: ink fill + accent `(3,3)` shadow | `.btn-primary`: accent fill, white text, no shadow | mobile-feed-spec §1, §2 |
| Accent is teal `#0e8f84` / `teal-deep` `#0a655d` | No teal anywhere | mobile-feed-spec §2 leftovers, iOS `Theme.swift` |
| Night `--text-muted` `#5e5850` | `#968e86` | ui_designer skill |
| `.section-label` colour `--text-muted` | `--text-primary` | ui_designer skill |
| Sidebar rail 60px / 56px | Not a token; check `MissionsSidebar.tsx` | mobile-feed-spec §6 / ui_designer skill |
| Radius 0 everywhere | `.filter-pill` has `border-radius: 3px`; its hover/active fills are hard-coded night `rgba(255,245,230,…)` | `globals.css` drift, not a doc |
| Status colours via tokens only | `StatusBadge` used raw `#D97706` for `waiting_on_you` and `infra_stalled`; fixed when it moved onto `Chip` (§4) | `StatusBadge.tsx` drift |

---

## 3. Type scale

One fixed set of roles replaces per-page `text-[Npx]` and `text-[Npx] md:text-[Npx]`
pairs. Mobile is below `md` (48rem); desktop is `md` and up. Sizes are chosen
from the values the app already uses most (`11px` and the `11 → 10` pair dominate
by a wide margin) so most call sites move by 0–1px. Nothing on mobile is under
11px.

| Role | Mobile | Desktop | Weight | Case / tracking | Line height | Use |
|---|---|---|---|---|---|---|
| `chip` | 11 | 10 | 600 | UPPERCASE, 0.5px | 1 | Status chips, pills, tags (= `.status-pill`) |
| `eyebrow` | 11 | 11 | 700 | UPPERCASE, 2px | 1.2 | Label above a title or section (= `.section-label`) |
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
**Replaces** lists of the other five are follow-up migrations.

Location: `apps/web/src/components/ui/`, next to `Dialog`, `Select`,
`Combobox`, `Switch`. Tokens only, no raw hex, no `text-[Npx]`, square chrome,
touch targets ≥ 44px on mobile.

### Chip

**Purpose:** the one way to show a state word. Square, 1px border, mono
uppercase, optional leading square dot (the `.status-pill` look).

**Built:** `components/ui/Chip.tsx`.

**Props:** `tone: 'success' | 'running' | 'warning' | 'error' | 'info' | 'accent' | 'muted'`,
`variant?: 'outline' (default) | 'soft' | 'solid'`, `dot?: boolean` (default true),
`pulse?: boolean` (live states), `children`, `trailing?: ReactNode` (a muted suffix such as `3m`),
`className?`, `data-testid` passthrough.

**Replaces:**
- `components/StatusBadge.tsx`: becomes a thin wrapper mapping `status → { tone, label }`
  over `Chip`. Keep the `StatusBadge` default export and the `STATUS_COLORS` /
  `STATUS_LABELS` exports, since several call sites import them. The two raw
  `#D97706` entries map to a token tone: `waiting_on_you → accent`,
  `infra_stalled → warning`. `StatusBadge` and `HeartbeatStatusBadge` use the
  `soft` variant so the tinted fill they had survives the swap.
- `missions/[id]/HeartbeatStatusBadge.tsx`: `LastCheckTone` maps 1:1 onto
  `success | warning | error | muted`; the relative time goes in `trailing`.
  Keep `data-testid="mission-last-check"`.
- `workspaces/[id]/config/ReleaseSection.tsx` local `StatusBadge`:
  `completed → success`, `failed → error`, `skipped`/other `→ muted`.

Later candidates (not the next task's scope): `StatusChip.tsx` (merge-policy
tier), `StageChip.tsx`, `LoopStatusChip`, and the `.health-pill` /
`.status-pill` classes themselves.

### Eyebrow

**Purpose:** the small uppercase label above a title, a card or a section
(type role `eyebrow`).

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
   surface (`StatusBadge`'s labels today; `Chip` callers after §4).

---

## Open questions

- ~~**`waiting_on_you` tone.**~~ Decided: `accent` (orange means "this is for
  you to act on").
- ~~**Desktop `chip` at 10px vs 11px.**~~ Decided: 10px on desktop, 11px below
  md, held in `--type-chip`.
- **`.filter-pill` radius and hard-coded fills.** Lean: square it and move its
  fills to tokens when the Chip lands.
- **iOS `Theme.swift`.** Lean: copy §2 into it on the next iOS task, rather than
  keeping a second table in the plan doc.

## Non-goals

- No colour, radius or shadow changes; every token is documented as shipped.
- The chat canvas's own tokens and rules stay in `docs/design/chat-canvas.md`.
- Mobile page layouts (sections, data mapping, the Missions Feed artboard) stay
  in `docs/design/mobile-feed-spec.md`.
