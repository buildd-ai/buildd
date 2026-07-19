# Design Spec — Buildd App (Brutalist / Editorial direction)

**Status**: Reference spec — build against this, confirm parity when done
**Primary target**: the **web dashboard** (`apps/web/`), responsive — desktop + mobile. The native iOS app (`docs/plans/ios-app-mvp.md`) shares this system; web has far more surface area.
**Direction**: brutalist/editorial — IBM Plex Mono, warm paper + ink, **single copper accent (`#c8956a`, buildd brand)**, square corners, hard offset shadows, corner-bracket panels.
**Intensity**: **Evolution** — restyle tokens + shared primitives (cascades to all ~40 web pages); stay pragmatic in dense tables/forms/markdown where rounding or softer treatment aids legibility. Not a mono-everything maximalist rebuild.
**Code source of truth (web)**: `apps/web/src/app/globals.css` CSS variables. The Pencil tokens mirror them.
**Canonical artboards** (`buildd-mobile.pen`): `Brutalist — Web Dashboard (desktop)` `c18a1`, `Brutalist — Missions Feed` `CZXce` (mobile), `Brutalist — Mission Detail` `pBOF7` (mobile).

> How to use this doc: align `globals.css` tokens once (§6), restyle the shared component layer, then build/verify each page against its artboard + the §5 checklist. A build is confirmed only when every token, measurement, and behavior matches.

## 0. Process — the reference triangle

Three artifacts stay in sync; each built screen is checked against all three:

1. **This spec + `globals.css`** — the written rules (tokens, measurements, behavior). For web, `globals.css` CSS variables are the executable source of truth; this doc explains intent.
2. **Pencil component kit** — reusable `C/*` modules rendered canonically on the **`DESIGN SYSTEM`** board (node `n56H3V`) in `buildd-mobile.pen`. The visual reference you diff a built component against. Editing a module (or a token) propagates to every artboard that instances it.
3. **Page artboards** — screens assembled *from* the kit, at the relevant widths: desktop (`c18a1`) and mobile (`CZXce`, `pBOF7`). The same kit drives both.

**Workflow per page:** restyle/build it from the spec → run the app (web at desktop ~1280 + mobile ~393; sim at 393pt for iOS) → place side-by-side with the page artboard → run the §5 checklist. File visual deltas against the kit, behavior deltas against the spec.

**Component kit (reusable nodes in `buildd-mobile.pen`):**

| Module | Node | SwiftUI view |
|--------|------|--------------|
| `C/StatusChip` | `wY4mj` | `StatusChip` (variant enum: solid/outline/accent/muted/tint) |
| `C/SectionHeader` | `fpVxm` | `SectionHeader` |
| `C/ShippedRow` | `GtR0o` | row in `ShippedTable` |
| `C/Button` | `yPmNK` | `BrutalButton` (primary/secondary) |
| `C/TaskCard` | `PkjRF` | `TaskCard` (toggle accent + progress) |
| `C/CornerBracketPanel` | `tMVny` | `CornerBracketPanel` |
| `C/BorderedTabBar` | `Jekqo` | `BorderedTabBar` |

Pages are pure composition of these — see Mission Detail (`pBOF7`), which is built only from `C/*` instances + a page-specific progress card and dark header.

---

## 1. Design tokens

### Color (three families only: ink, paper, copper)

Accent is **copper** — buildd's existing brand accent (`globals.css` `--primary`/`--accent` `#c8956a`). The brutalist treatment is square corners + hard shadows + mono, *not* a new accent color. Token names below are the spec/`globals.css` names; the Pencil file uses legacy `m-teal*` variable names for the copper accent (values are copper — a naming wart, not a second color).

| Token (spec / globals.css) | Hex | Use |
|-------|-----|-----|
| `ink` (`--text-primary` night-on-light contexts use `#2a2520`) | `#101216` | text, borders, dark header bg, solid chips, hard shadow |
| `ink-soft` | `#3a414c` | secondary body text |
| `ink-faint` (`--text-muted`) | `#6b7280` | meta, captions, inactive |
| `paper` (`--surface-1` light) | `#f4f3ee` | app background (warm off-white) |
| `card` (`--card` light) | `#ffffff` | card / panel / table surfaces |
| `hair` (`--border`) | `#d9d8d0` | internal hairlines, progress track, muted borders |
| `accent` (`--primary` / `--accent`) | `#f4811f` | the single accent — section numbers, accent bars, progress fill, active state. **Classic Apple rainbow orange** — replaces the brand's old washed-out `#c8956a`. |
| `accent-deep` (`--accent-text`) | `#b5450c` | accent text on light (task IDs, %, links) — burnt-orange, readable contrast |
| `accent-tint` (`--accent-soft` flattened) | `#fde7d2` | accent chip fill |
| `accent-border` | `#f6c79a` | accent hairline |
| `eyebrow` | `#b59a86` | eyebrow on dark header (warm grey) |
| `sub` | `#c4bbb0` | subtitle on dark header |
| `meta` / `meta-b` | `#9a9088` / `#d8cfc4` | meta key / value on dark header |
| `rule` | `#2e2a26` | hairline on dark header |

Status colors (keep the existing `globals.css` set — `--status-success #5ec495`, `--status-warning #e0b35a`, `--status-error #d4736a`, `--status-info #7aacca`) for non-accent semantic states. Discipline: **no second decorative accent, no gradients, no soft shadows, no blur.** Color carries meaning (running, accent, done) — never decoration.

### Type — IBM Plex Mono (one family, everywhere)

| Role | Size / Weight | Tracking / Line-height | Notes |
|------|---------------|------------------------|-------|
| Display (masthead title) | 30 / 700 | -0.3 letter | UPPERCASE |
| Section heading | 14 / 600 | +0.4 letter | UPPERCASE |
| Card title | 14 / 600 | — | line-height 1.35, sentence case |
| Body / agent question | 13 / 400 | — | line-height 1.45 |
| Subtitle (on ink) | 12.5 / 400 | — | line-height 1.5 |
| Task ID | 12.5 / 700 | — | `accent-deep` |
| Meta / row label | 11–11.5 / 400 | +0.3–0.5 letter | `ink-faint` |
| Micro / chip | 10 / 600 | +0.6 letter | UPPERCASE |
| Tab label | 10 / 400–600 | +0.3 letter | sentence case |

> The status bar (`9:41`, signal/wifi/battery) is the one exception — system rendering is fine. Everything app-owned is IBM Plex Mono.

### Geometry

- **Corner radius: 0.** Nothing is rounded. Square corners are the brand.
- **Borders: 1.5px** solid `ink`, inner alignment. Hairlines: 1px `hair`.
- **Hard shadow** (the brutalist drop): solid fill, `blur: 0`, `spread: 0`, offset **(x:5, y:5)**, color `ink`. On the primary action button only, offset (3,3) color `accent`. Never a blurred/alpha shadow.
- **Screen width**: 393pt. **Content side padding**: 20pt. **Masthead/status side padding**: 24pt.
- **Spacing**: section-to-section 26; header-to-list 14–16; card-to-card 18; intra-card 10.

---

## 2. Components

### Masthead (dark header)
- `ink` background, padding `[26, 24, 22, 24]`, vertical, gap 13, full width.
- Eyebrow `BUILDD · MISSIONS` — 11 / 500 / +2.4 letter / `eyebrow`.
- Title `TODAY'S RUNS` — 30 / 700 / `#ffffff`.
- Subtitle — 12.5 / `sub`, wraps.
- Meta row — 1px top border `rule`, top padding 14, horizontal gap 22. Each cell = `KEY` (11, `meta`) + `value` (11 / 600, `meta-b`). Cells: workspace name · date · live worker count.

### Section header
Horizontal, gap 10, centered: `NN` number (13 / 700, `teal`) · `LABEL` (14 / 600, `ink`) · flexible spacer · count (11, `ink-faint`, right-aligned).

### Task card (the core unit)
- White, 1.5 `ink` border, **hard ink shadow (5,5)**.
- Horizontal: optional 5px `teal` left accent (active runs) implemented as the inner frame's left border, then content column padding `[14, 15, 15, 16]`, gap 10.
- **Top row** (space-between): task ID (12.5 / 700 `teal-deep`) · status chip.
- **Title** — 14 / 600 / 1.35 `ink`, wraps.
- **Meta** — 11.5 `ink-faint`: `ROLE · model · worker-id` (e.g. `BUILDER · opus-4.8 · worker-03`).
- **Progress** (running only): 5px track `hair` with `teal` fill at `progress%`; below it a space-between row of `DS-7 · 14 turns` (11 `ink-faint`) and `62%` (11 / 600 `teal-deep`).

### Status chip
Padding `[3,8]`, 1.5 border, text 10 / 600 / +0.6 / UPPERCASE. Four variants:
- **solid** — `ink` fill, white text, `ink` border → RUNNING
- **teal** — `teal` fill, white text → live/success states
- **outline** — `card` fill, `ink` text + border → SCHEDULED / DAILY · 09:00
- **muted** — `card` fill, `ink-faint` text, `hair` border → low-priority
- (special) **tint** — `teal-tint` fill, `teal-deep` text, `teal` border → PAUSED

### Corner-bracket panel ("Needs input")
- White, 1.5 `ink` border, **fixed height** (so bracket marks anchor); padding `[18,16,16,16]`, gap 12.
- **Four corner brackets**: 14×14 L-marks (3px stroke, two adjacent sides), offset −2 outside each corner.
- Header row: task ID (`teal-deep`) · `ROLE · worker-id` (`ink-faint`) · spacer · `PAUSED` tint chip.
- Question — 13 / 1.45 `ink`, wraps.
- Action row: primary button (`ink` fill, white text, **teal hard shadow (3,3)**) · secondary button (`card` fill, `ink` text/border) · spacer · reply field (`hair` border, `ink-faint` placeholder + `corner-down-left` icon). Buttons padding `[9,14]`, label 12 / 600 / +0.4.

### Shipped table
- White, 1.5 `ink` border, hard ink shadow (5,5), vertical.
- Rows: padding `[11,14]`, gap 10, centered; 1px `hair` bottom divider on all but the last.
- Row content: `check` icon (14, `teal`) · task ID (11.5 / 700 `teal-deep`) · title (12 `ink-soft`, fills width, single line) · relative time (11 `ink-faint`).

### Tab bar
- White, **1.5 `ink` top border**, padding `[0,18,26,18]` (bottom clears the home indicator), space-between.
- Each tab (width 74, centered): 2.5px top indicator (`teal` active / transparent inactive) · icon (21) · label (10). Active = `teal-deep` + 600 weight; inactive = `ink-faint`.
- Tabs: **Feed** (`layout-list`) · **Missions** (`target`) · **Create** (`square-plus`) · **Activity** (`activity`).

---

## 3. Screen — Missions Feed

Vertical stack, paper background, `clip: true`:

1. **Status bar** (62) — time + system icons.
2. **Masthead** — eyebrow / title / subtitle / meta(workspace · date · live workers).
3. **Content** (padding `[22,20,28,20]`, gap 26):
   - `01 RUNNING NOW` — accented task cards with progress.
   - `02 SCHEDULED` — outline-chip cards, no progress.
   - `! NEEDS INPUT` — corner-bracket panel(s).
   - `03 SHIPPED TODAY` — shipped table.
4. **Tab bar** — Feed active.

### Data mapping (existing API — see `../plans/ios-app-mvp.md`)

| Section | Source | Notes |
|---------|--------|-------|
| Masthead meta | workspace + `GET /api/workers` (active count) | "4 live" = workers in active state |
| 01 Running now | `GET /api/tasks?status=running` (+ worker turns) | progress = task progress or turns/maxTurns; accent bar on all |
| 02 Scheduled | `GET /api/cron/schedules` / upcoming `taskSchedules` | chip shows cadence (`DAILY · 09:00`) |
| ! Needs input | `GET /api/tasks?status=waiting_input` + `GET /api/workers/[id]` | question text + agent-offered options → buttons; reply → `POST /api/workers/[id]/instruct` |
| 03 Shipped today | `GET /api/tasks?status=completed` filtered to today | newest first, relative time |

Role → chip/meta label uses `tasks.roleSlug` (`BUILDER` / `ORGANIZER` / `RESEARCHER`); model from the role config.

---

## 4. Implementation notes (SwiftUI)

- **Font**: bundle IBM Plex Mono (Regular/Medium/SemiBold/Bold). Register via `UIAppFonts`; expose a `Font.plexMono(_:weight:)` helper. Do not fall back to the system monospace.
- **Hard shadow**: SwiftUI's `.shadow` is always blurred — do **not** use it. Render the hard offset as a sibling layer: a filled `Rectangle` (`ink`) offset by (5,5) behind the card via `ZStack`/`background(alignment:)`, or an overlay rectangle. Same for the teal (3,3) button shadow.
- **Corner brackets**: draw with a `Path`/`Shape` (two strokes per corner) or four small bracket views in an `overlay`. Keep them outside the panel bounds (−2) — don't clip.
- **Square corners**: never apply `cornerRadius`. Default many SwiftUI controls round — override.
- **Accent bar**: a 5pt `teal` rectangle as a leading border (`HStack` or leading overlay), not a full re-stroke.
- **Tokens**: put the table in §1 into one `BuilddTheme` (Color + Font + spacing constants). No raw hex in views.
- **Accessibility**: ship Dynamic Type (scale the mono sizes), ensure ink-on-paper and white-on-ink meet contrast (they do); teal-deep `#0a655d` is the readable teal for text on light — never use `teal` `#0e8f84` for small text on paper.
- **Optional**: a true dotted offset shadow (the turbopuffer look) is available as `dotgrid.glsl` in the repo root if a future hero card uses a fixed height; the default everywhere is the solid hard shadow.

---

## 5. Acceptance checklist (confirm build against this)

**Tokens & type**
- [ ] All surfaces use the §1 palette; zero off-palette hex in code.
- [ ] IBM Plex Mono renders on every app-owned label (not system mono).
- [ ] No rounded corners anywhere; all borders 1.5px ink / 1px hair.
- [ ] Every shadow is a hard solid offset (blur 0); the primary button shadow is teal (3,3), all others ink (5,5).

**Masthead**
- [ ] Ink background, eyebrow tracked +2.4, title 30/700 uppercase, meta row divided by a 1px `rule` hairline.

**Cards**
- [ ] Running cards show teal left accent + progress (track + fill + `%` in teal-deep).
- [ ] Status chips match the correct variant per state (solid/outline/tint).
- [ ] Card meta reads `ROLE · model · worker`.

**Needs-input panel**
- [ ] Four corner brackets present and sitting ~2px outside the corners.
- [ ] Primary action has the teal hard shadow; reply affordance present; instruct call wired.

**Shipped table & tabs**
- [ ] Hairline dividers between rows, none after the last; teal check icons.
- [ ] Tab bar has a 1.5px ink top border; active tab shows teal top indicator + teal-deep label.

**Behavior / data**
- [ ] Each section pulls from the mapped endpoint; empty sections collapse (no empty headers).
- [ ] Pull-to-refresh + Pusher live updates reflected; `waiting_input` raises a push and surfaces the panel.
- [ ] Side-by-side with the artboard screenshot at 393pt: spacing and hierarchy visually match.

---

## 6. Web application — scope & token migration

The web dashboard (`apps/web/`) already has a warm, fully-responsive design system that's a close cousin of this one (Outfit/Fraunces + IBM Plex Mono, copper `#c8956a`, warm charcoal/linen dual theme, `.card`/`.section-label`/`.mission-card` utilities). Adopting the brutalist direction is a **token + shared-primitive restyle that cascades to ~40 pages**, not 40 rebuilds.

### The four moves (the whole diff)

| | Web today | Target |
|---|---|---|
| Accent | washed copper `#c8956a` | **classic Apple orange `#f4811f`** (retro, high-energy, warm) |
| Corners | `--radius` 6–24px | **0** (square) — `border-radius` tokens → 0 (evolution: may keep a 2–4px on dense table rows/inputs if 0 reads harsh) |
| Shadows | soft blur (`--card-shadow`) | **hard offset** — solid, blur 0, (4–5px, ink) |
| Headings | Outfit / Fraunces | IBM Plex Mono for headings/labels/numbers; body & long-form markdown may stay Outfit for readability |

### globals.css changes (do first — cascades everywhere)

1. **Radius**: set the `borderRadius` scale in `tailwind.config.ts` (`sm/md/lg/xl`) toward 0 (keep ≤4px only where evolution demands).
2. **Shadow**: redefine `--card-shadow` (both themes) to a hard offset — e.g. `4px 4px 0 0 var(--ink)` (use the strong border color on light, near-black on dark). Audit `animate-card-enter` etc. to not reintroduce soft drop.
3. **Borders**: bump `--border`/`--border-strong` to a solid 1.5px ink-ish hairline; default cards get a visible 1.5px border (brutalist needs the outline, not just shadow).
4. **Type**: route heading utilities + `.section-label`/`.type-label` to `--font-ibm-plex-mono`; keep body on Outfit (evolution).
5. **Accent**: change `--primary`/`--accent` from `#c8956a` → `#f4811f` (classic Apple orange; update `--primary-hover`, `--primary-subtle`, `--accent-soft`, `--accent-text` to match). Add `--accent-deep #b5450c` for accent text needing contrast on light. Re-check both themes' contrast after the change (pure orange on white fails small-text contrast — use `--accent-deep` for text).
6. **Corner-bracket panel**: add a `.bracket-panel` utility (4 corner L-marks) for needs-input / gate surfaces.

### Shared primitives to restyle (cascade order)

`.card` / `.card-interactive` → `.mission-card` (keep 4px left status border, square the rest) → buttons (primary = ink fill + accent hard shadow; secondary = bordered) → `components/ui/Select.tsx` + `BackendSelect.tsx` → badges/`.health-pill`/`.filter-pill` (→ StatusChip variants) → `.glow-dot` → modals/sheets (`ConfirmDialog`, `QuickCreateModal`, `StartTaskModal`) → grids (`MissionGrid`/`TaskGrid`/`TeamGrid`) → `MarkdownContent` (square code blocks).

### Reference pages to pin in Pencil (desktop ≥1280 + mobile 393)

Pin only the few that exercise everything; the rest inherit from the restyled primitives.

1. **Dashboard / Home** — `c18a1` (desktop) ✓ built. Sidebar shell + stat tiles + running grid + needs-input + shipped.
2. **Mission Detail** — `pBOF7` (mobile) ✓; desktop variant TODO (tabbed, inline edit, schedule).
3. **Task Detail (realtime)** — TODO. Streaming worker view + logs + respond form — the densest, most behavior-heavy page.
4. **Missions list** — TODO. Filter pills + mission-card grid.

### Web acceptance addendum (in addition to §5)

- [ ] `globals.css` radius → 0 (≤4px exceptions noted), `--card-shadow` is a hard offset, default card border 1.5px ink.
- [ ] Both **day and night** themes updated and visually correct (don't break the existing dual-theme system).
- [ ] Desktop sidebar shell matches `c18a1`: 60px ink rail, active item on accent-tint, top icons + bottom settings/avatar.
- [ ] Dense views (tables, forms, realtime logs, markdown) remain legible — evolution exceptions are deliberate and documented, not accidental leftovers.
- [ ] Responsive parity: each restyled page checked at ~1280 **and** ~393.
