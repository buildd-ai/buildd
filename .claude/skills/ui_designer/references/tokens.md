> **DRIFT WARNING (2026-07):** Parts of this file predate the brutalist redesign (#892/#894/#907). Where values disagree with `apps/web/src/app/globals.css` or `docs/design/mobile-feed-spec.md`, those win: accent is `#f4811f` (not copper `#c8956a`), corner radius is 0 (not 6-14px), shadows are hard offsets (`5px 5px 0 0`, blur 0), and headings/labels are IBM Plex Mono.

# Buildd Design Tokens

Complete token reference. Source of truth: `apps/web/src/app/globals.css` and `apps/web/tailwind.config.ts`.

## Theme System

Themes are toggled via `[data-theme="dark"]` and `[data-theme="light"]` on `:root`. Default is dark. All tokens are CSS custom properties — never hardcode hex values in components.

## Color Tokens

### Primary & Accent

| Token | Dark Value | Light Value | Usage |
|-------|-----------|-------------|-------|
| `--primary` | `#f4811f` | `#f4811f` | CTAs, active states, primary buttons |
| `--primary-hover` | `#d96e12` | `#d96e12` | Hover states for primary elements |
| `--primary-subtle` | `rgba(244,129,31,0.10)` | `rgba(244,129,31,0.10)` | Selected states, subtle highlights |
| `--primary-ring` | `rgba(244,129,31,0.30)` | `rgba(244,129,31,0.28)` | Focus rings (input focus box-shadow) |
| `--accent` | `#f4811f` | `#f4811f` | Same as primary — fills only, never small text on light |
| `--accent-soft` | `rgba(244,129,31,0.14)` | `rgba(244,129,31,0.12)` | Soft accent backgrounds |
| `--accent-text` | `#f59b4e` | `#aa410b` | Accent-colored text (darkened in light to clear 4.5:1 on paper and card) |
| `--accent-deep` | `#f7a261` | `#b5450c` | Deeper accent variant |

### Surfaces

Warm-toned elevation stack. Never blue-gray, never pure black.

#### Night — Warm Charcoal (`:root, [data-theme="dark"]`)

| Token | Value | Role |
|-------|-------|------|
| `--surface-1` | `#1a1816` | Page background (deepest layer) |
| `--surface-2` | `#211f1c` | Elevated panels, secondary areas |
| `--surface-3` | `#2a2724` | Hover states, active items |
| `--surface-4` | `#302c28` | Tooltips, highest elevation |
| `color-scheme` | `dark` | Browser native styling hint |

#### Day — Warm Linen (`[data-theme="light"]`)

| Token | Value | Role |
|-------|-------|------|
| `--surface-1` | `#e7e3db` | Page background (paper) |
| `--surface-2` | `#eee9e3` | Elevated panels |
| `--surface-3` | `#e5dfd8` | Hover states |
| `--surface-4` | `#dbd4cc` | Highest elevation |
| `color-scheme` | `light` | Browser native styling hint |

### Cards

| Token | Dark Value | Light Value |
|-------|-----------|-------------|
| `--card` | `#2a2724` | `#ffffff` |
| `--card-hover` | `#302c28` | `#fdfcfa` |
| `--card-finding` | `#252220` | `#faf8f5` |
| `--card-rightnow` | `#1f1d1a` | `#f5f2ee` |
| `--card-border` | `rgba(255, 245, 230, 0.06)` | `rgba(0, 0, 0, 0.06)` |
| `--card-shadow` | `0 1px 4px rgba(12, 10, 8, 0.35)` | `0 1px 4px rgba(0, 0, 0, 0.06)` |

### Text Colors

| Token | Dark Value | Light Value | Usage |
|-------|-----------|-------------|-------|
| `--text-primary` | `#ede8e2` | `#1f1b17` | Headings, labels, primary content |
| `--text-secondary` | `#a89f96` | `#423c35` | Descriptions, body text |
| `--text-desc` | `#9f978e` | `#5f5850` | Descriptions — between secondary and muted |
| `--text-muted` | `#968e86` | `#6a625a` | Timestamps, tertiary info, small labels, placeholders |

#### Contrast floor

Every text token above — and `--accent-text` — must reach WCAG AA **4.5:1** against
`--surface-1`, `--surface-2` and `--card` in **both** themes. Hierarchy
(secondary > desc > muted) is expressed inside that floor, not below it.

Documented exemption: on `--surface-4` (tooltips, highest elevation) the floor is
**3:1** for all text tokens.

Enforced by `apps/web/src/app/globals-contrast.test.ts`, which parses
`globals.css`. When picking a new value, run that test — "looks a bit lighter"
is how light-theme muted drifted to ~2.4:1.

### Borders

| Token | Dark Value | Light Value |
|-------|-----------|-------------|
| `--border` | `rgba(255, 245, 230, 0.07)` | `rgba(0, 0, 0, 0.07)` |
| `--border-strong` | `rgba(255, 245, 230, 0.12)` | `rgba(0, 0, 0, 0.12)` |

### Chrome (Navigation Shell)

| Token | Dark Value | Light Value |
|-------|-----------|-------------|
| `--chrome-bg` | `rgba(26,24,22,0.92)` | `rgba(247,244,240,0.92)` |
| `--chrome-sidebar` | `#15130f` | `#eee9e3` |

### Status Colors

The ONLY bright/saturated colors in the UI. Each maps to exactly one semantic meaning.

| Token | Dark Value | Light Value | Meaning |
|-------|-----------|-------------|---------|
| `--status-success` | `#5ec495` | `#3a9864` | Completed, online, healthy |
| `--status-running` | `#c8956a` | `#b07d4f` | Active, in-progress (pulse animation) |
| `--status-warning` | `#e0b35a` | `#9a7a20` | Queued, attention needed |
| `--status-error` | `#d4736a` | `#c0524a` | Failed, errors, destructive |
| `--status-info` | `#7aacca` | `#5088b0` | Informational |

**Status color usage rules:**
- Badges: status color as text + 10% opacity background
- Dots: 6-8px circles in the status color
- Glow dots: `box-shadow` glow (0.4 alpha dark, 0.25 alpha light)
- NEVER used as page/card backgrounds
- NEVER used decoratively

### Category Colors (Task Types)

| Category | Dark Value | Light Value |
|----------|-----------|-------------|
| `--cat-bug` | `#d4736a` | `#c0524a` |
| `--cat-feature` | `#7aacca` | `#5088b0` |
| `--cat-refactor` | `#a78bfa` | `#8b6dd4` |
| `--cat-chore` | `#8a827a` | `#8a827a` |
| `--cat-docs` | `#5ec495` | `#3a9864` |
| `--cat-test` | `#e0b35a` | `#9a7a20` |
| `--cat-infra` | `#c8956a` | `#b07d4f` |
| `--cat-design` | `#d4a574` | `#b07d4f` |

## Spacing Tokens

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `4px` | Tight gaps (between dot and badge text) |
| `--space-sm` | `8px` | Small gaps (between related items) |
| `--space-md` | `16px` | Standard gaps (grid gaps, padding) |
| `--space-lg` | `24px` | Section gaps, card padding |
| `--space-xl` | `32px` | Main content padding |
| `--space-2xl` | `48px` | Page-level padding |
| `--space-3xl` | `64px` | Major section breaks |

## Border Radius Tokens

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | `6px` | Buttons, inputs, small elements |
| `--radius-md` | `10px` | Icon buttons, sidebar items |
| `--radius-lg` | `14px` | Cards |
| `--radius-xl` | `24px` | Large containers |
| `100px` (pill) | — | Status badges only |

## Tailwind Class Mapping

Colors are mapped via CSS vars in `tailwind.config.ts`:

| Tailwind Class | CSS Variable |
|---------------|-------------|
| `bg-primary` | `var(--primary)` |
| `bg-surface-1` ... `bg-surface-4` | `var(--surface-1)` ... `var(--surface-4)` |
| `bg-card` | `var(--card)` |
| `text-text-primary` | `var(--text-primary)` |
| `text-text-secondary` | `var(--text-secondary)` |
| `text-text-muted` | `var(--text-muted)` |
| `text-text-desc` | `var(--text-desc)` |
| `border-border-default` | `var(--border)` |
| `border-border-strong` | `var(--border-strong)` |
| `text-accent-text` | `var(--accent-text)` |
| `bg-accent-soft` | `var(--accent-soft)` |
| `text-status-success` | `var(--status-success)` |
| `text-status-running` | `var(--status-running)` |
| `text-status-warning` | `var(--status-warning)` |
| `text-status-error` | `var(--status-error)` |
| `text-status-info` | `var(--status-info)` |
| `text-cat-bug`, `text-cat-feature`, ... | `var(--cat-bug)`, `var(--cat-feature)`, ... |
