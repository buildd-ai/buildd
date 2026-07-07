---
name: ui_designer
description: "Apply the buildd brand identity to UI code. Enforces design tokens, color discipline, typography, and the day/night theme system across all buildd apps."
---

# Buildd UI Designer Skill

Apply the buildd brand identity to UI code. This skill enforces the design system defined in `globals.css` and `tailwind.config.ts` — tokens, color discipline, typography, surfaces, and component patterns.

**Direction: brutalist/editorial** (adopted 2026-06 via PRs #892/#894/#907; spec in `docs/design/mobile-feed-spec.md`). Square corners, hard offset shadows, visible ink borders, IBM Plex Mono as the product voice, one orange accent. If anything in this skill contradicts `apps/web/src/app/globals.css`, **globals.css wins** — flag the drift.

## When to Use This Skill

- Writing or modifying any UI component in buildd apps
- Reviewing existing UI for brand consistency
- Adding new pages, panels, or features to the dashboard
- Choosing colors, spacing, typography, or component styling
- Deciding how to present status, hierarchy, or interactive elements

## Brand Vibe

**"A control room in print. Everything has a place. The borders do the talking."**

Brutalist/editorial: warm paper and charcoal surfaces, hard ink outlines, hard offset shadows, monospace headings, a single high-energy orange accent. Color earns its presence through meaning — orange for action/progress, green for success, red for errors. No decorative gradients, no soft blur, no rounded corners.

## Theme Architecture

Day/Night toggle via `[data-theme="dark"]` and `[data-theme="light"]` CSS selectors on `:root`.

- **ThemeProvider** React context: `dark > light > system` cycle
- **localStorage** persistence: `buildd-theme` key
- Inline `<head>` script prevents flash of wrong theme
- **Default**: dark (Warm Charcoal)
- Chrome vars `--chrome-bg` and `--chrome-sidebar` adapt the navigation shell

All colors use CSS custom properties so both themes work automatically. Never hardcode hex values — always use `var(--token)` or the Tailwind class mapped to it.

## Core Principles

### 1. Color Earns Its Place
Every use of color communicates status or invites action. No decorative gradients. No status colors as button or card backgrounds. If it's colored, it means something.

### 2. Borders and Hard Shadows Carry Hierarchy
Depth comes from **visible borders** (2px `--border-strong` on cards, 1px `--border` hairlines inside) and the **hard offset shadow** (`--card-shadow`: `5px 5px 0 0`, solid, blur 0). Never a soft blurred drop-shadow. Surfaces `surface-1 > 2 > 3 > 4` still order elevation for fills and hovers.

### 3. Square Everything
**Corner radius is 0.** The Tailwind `borderRadius` scale (`sm/md/lg/xl`) is zeroed in config — but do not write `rounded-full` or `rounded-[Npx]` arbitrary values, which bypass it. Dense table rows/inputs may keep ≤4px only as a deliberate, documented exception.

### 4. Mono Is the Voice
IBM Plex Mono for headings, labels, numbers, meta, and data (weights 400–700 are loaded). Outfit for long-form body/markdown where mono hurts readability. Fraunces never appears in product UI.

### 5. Progressive Disclosure & Lean Navigation
Default view is lean; hide advanced functionality behind toggles. Sidebar is a 56px icon rail; active items get accent color; mobile uses the fixed bottom nav.

## Design Tokens (Summary)

Full token tables in `references/tokens.md`; canonical values in `globals.css`. Key values:

### Night — Warm Charcoal (default)
| Token | Value | Usage |
|-------|-------|-------|
| `--surface-1` | `#1a1816` | Page background (deepest) |
| `--surface-2` | `#211f1c` | Elevated panels |
| `--card` | `#2a2724` | Card backgrounds |
| `--text-primary` | `#ede8e2` | Headings, labels |
| `--text-secondary` | `#a89f96` | Descriptions, body |
| `--text-muted` | `#5e5850` | Timestamps, tertiary |
| `--primary` / `--accent` | `#f4811f` | CTAs, active states, progress fills |
| `--accent-text` / `--accent-deep` | `#f59b4e` / `#f7a261` | Accent text on dark |
| `--border` | `rgba(255,245,230,0.14)` | Hairlines |
| `--border-strong` | `rgba(255,245,230,0.55)` | Card outlines |
| `--card-shadow` | `5px 5px 0 0 rgba(255,245,230,0.5)` | Hard offset shadow |
| Status | `#5ec495` / `#e0b35a` / `#d4736a` / `#7aacca` | success / warning / error / info |

### Day — Warm Paper
| Token | Value | Usage |
|-------|-------|-------|
| `--surface-1` | `#e7e3db` | Page background (paper) |
| `--surface-2` | `#eee9e3` | Elevated panels |
| `--card` | `#ffffff` | Card backgrounds |
| `--text-primary` | `#1f1b17` | Headings, labels |
| `--primary` / `--accent` | `#f4811f` | CTAs (same hue, both themes) |
| `--accent-text` / `--accent-deep` | `#b5450c` | **Accent text on light** — pure orange fails small-text contrast |
| `--border` | `rgba(0,0,0,0.42)` | Hairlines |
| `--border-strong` | `#1a1512` | Card outlines (ink) |
| `--card-shadow` | `5px 5px 0 0 rgba(26,21,18,0.95)` | Hard ink shadow |
| Status | `#3a9864` / `#9a7a20` / `#c0524a` / `#5088b0` | success / warning / error / info |

### Category Colors (task types)
Unchanged — see `references/tokens.md`. Category colors appear on badges/dots only.

## Typography (Summary)

Full spec in `references/typography.md`. Three font families, each with a strict role:

| Font | CSS Variable | Role |
|------|-------------|------|
| **IBM Plex Mono** | `--font-ibm-plex-mono` | The product voice: headings, section labels, badges, data, timestamps, meta. Weights 400/500/600/700 loaded. |
| **Outfit** | `--font-outfit` | Long-form body and markdown where mono hurts readability |
| **Fraunces** | `--font-fraunces` | Marketing display only. **Never in product UI.** |

### Key Type Scale
| Role | Font | Size | Weight |
|------|------|------|--------|
| Page title (H1) | Plex Mono | 20–28px | 600 |
| Section label | Plex Mono | 11px | 500–700, uppercase, 2px letter-spacing |
| Card title | Plex Mono | 14–15px | 600 |
| Body / UI label | Plex Mono | 13px | 400–500 |
| Long-form body | Outfit | 14px | 400 |
| Status badge / chip | Plex Mono | 10–11px | 500–600, uppercase |
| Meta / timestamp | Plex Mono | 11px | 400 |

## Component Patterns (Summary)

Full spec in `references/components.md`.

### Cards
`.card` utility: `bg: var(--card)`, **2px solid `var(--border-strong)`**, **radius 0**, `box-shadow: var(--card-shadow)` (hard offset). Interactive hover: slight `-translate-y-px`, never a soft shadow. Mission cards keep the 4–6px left status border.

### Buttons
- **Primary**: `bg-primary` (`#f4811f`), white text, square (`rounded-sm` = 0), 13px mono 500, `hover:bg-primary-hover`
- **Secondary**: `bg-surface-3`, `text-text-primary`, `border border-border-strong`, square
- **Ghost**: transparent, secondary text color
- Never use a status color (`--status-*`) as a button background.

### Status Badges / Pills
Square chips (`.health-pill`, `.filter-pill`), 10–11px IBM Plex Mono 500–600 uppercase. Colored dot + text; background = status color at low opacity. Running/warning dots pulse.

### Inputs
`bg: var(--surface-1)`, `border: var(--border)`, **radius 0**. Focus: `border-color: var(--primary)` + ring.

### Section Labels
`.section-label`: IBM Plex Mono 11px, uppercase, 2px letter-spacing, `color: var(--text-muted)`.

### Sidebar (MissionsSidebar)
56px icon rail, `bg: var(--chrome-sidebar)`, border-right. Icon buttons 40×40, **square**. Active = accent-text color. Nav items come from `lib/nav-config.tsx` (`NAV_ITEMS`) — never hardcode nav in a component. Custom hover tooltip chip (square); no native `title` attributes.

### Bottom Nav (MissionsBottomNav)
Fixed bottom, `bg: var(--chrome-bg)`, border-top, 56px tall, mobile only (`md:hidden`). Consumes the same `NAV_ITEMS`.

## Tailwind Usage

Colors are mapped via CSS vars in `tailwind.config.ts`. Use semantic class names (`bg-primary`, `bg-surface-1..4`, `bg-card`, `text-text-primary/secondary/muted`, `border-border-default/strong`, `text-status-*`, `text-cat-*`). `boxShadow` sm/md/lg are hard offsets — use them or `shadow-[var(--card-shadow)]`.

## Anti-Patterns (DO NOT)

- **No rounded corners** — no `rounded-full`, `rounded-[10px]`, etc. on surfaces, buttons, chips (the config zeroes the scale; arbitrary values bypass it)
- **No soft shadows** — never `shadow-md`/`shadow-lg` defaults or blurred drop-shadows; only hard offsets
- **No gradients** — progress fills and accents are flat `var(--accent)`
- **No status colors as backgrounds** for buttons, cards, or pages — badges, dots, small indicators only
- **No raw hex in components** — always CSS vars so themes work
- **No Fraunces in product UI** (marketing only); no italic display flourishes in the app
- **No second decorative accent** — blue (`--status-info`) is for info states, not Edit buttons
- Don't clutter sidebars; don't overwhelm forms — progressive disclosure
- No slate/blue-gray tones — the palette is warm

## Applying the Design System — Checklist

When writing or reviewing UI code:

1. **Check corners** — anything rounded? Remove it.
2. **Check shadows** — any blur? Replace with `var(--card-shadow)` or none.
3. **Check colors** — all tokens? Every non-neutral color semantic? Accent text on light uses `--accent-text`?
4. **Check typography** — mono for UI/headings/labels, Outfit only for long-form, no Fraunces?
5. **Check theme** — works in both dark and light? CSS vars only?
6. **Check components** — buttons/badges/inputs/cards follow the patterns above? Nav from `NAV_ITEMS`?
7. **Check restraint** — anything screaming? Would removing an element improve it?

## Source of Truth

- **Canonical CSS tokens**: `apps/web/src/app/globals.css` (wins over any doc, including this one)
- **Design spec**: `docs/design/mobile-feed-spec.md` (tokens §1, components §2, web migration §6)
- **Tailwind config**: `apps/web/tailwind.config.ts`
- **Detailed token tables**: `references/tokens.md`
- **Typography spec**: `references/typography.md`
- **Component spec**: `references/components.md`
