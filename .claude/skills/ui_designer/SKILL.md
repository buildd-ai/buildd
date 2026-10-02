---
name: ui_designer
description: "Apply the buildd brand identity to UI code. Enforces design tokens, color discipline, typography, and the day/night theme system across all buildd apps."
---

# Buildd UI Designer Skill

Apply the buildd brand identity to UI code.

**Read [`docs/design/design-system.md`](../../../docs/design/design-system.md) first. It is the one design reference:** direction, every token (read from `globals.css`), the fixed type scale, the shared primitives (Chip, Eyebrow, Section, Lede, PrimaryAction, Disclosure, Sheet) and the copy rules. This skill only carries the principles and the review checklist; it deliberately has no token table of its own.

**Executable source of truth:** `apps/web/src/app/globals.css` and `apps/web/tailwind.config.ts`. If anything (this skill, the design doc, any older spec) contradicts `globals.css`, **globals.css wins** — flag the drift.

## When to Use This Skill

- Writing or modifying any UI component in buildd apps
- Reviewing existing UI for brand consistency
- Adding new pages, panels, or features to the dashboard
- Choosing colors, spacing, typography, or component styling
- Deciding how to present status, hierarchy, or interactive elements

## Brand Vibe

**"A control room in print. Everything has a place. The borders do the talking."**

Brutalist/editorial: warm paper and charcoal surfaces, hard ink outlines, hard offset shadows, IBM Plex Mono as the voice, a single orange accent. Color earns its presence through meaning — orange for action/progress, green for success, red for errors.

## Core Principles

1. **Color earns its place.** Every colour communicates state or invites action. Status colours go on chips, dots, left borders and text, never as a button, card or page fill.
2. **Borders and hard shadows carry hierarchy.** 2px `--border-strong` frames, 1px `--border` hairlines, `--card-shadow` hard offsets. Never a blurred shadow.
3. **Square everything.** Radius 0; the Tailwind scale is zeroed. Don't write `rounded-[Npx]` arbitrary values. The chat canvas conversation is the one sanctioned soft surface (`knowledge-base: buildd/design/chat-canvas.md`).
4. **Mono is the voice.** IBM Plex Mono everywhere app-owned. Fraunces never appears in product UI.
5. **Use the type scale, not `text-[Npx]`.** Pick a role from design-system §3; nothing under 11px below `md`.
6. **Reuse primitives.** Don't hand-roll a status chip or a bottom sheet; see design-system §4.
7. **Plain words in headlines.** No paths, symbols or PR numbers in owner-facing headline copy (design-system §5).
8. **Both themes.** Day/Night via `[data-theme]`; CSS vars or the Tailwind classes mapped to them, never raw hex.

## Anti-Patterns (DO NOT)

- Rounded corners on chrome (`rounded-full`, `rounded-[10px]`)
- Soft or blurred shadows, `backdrop-blur`
- Gradients (the chat sea is the one exception, owned by chat-canvas)
- Status colours as backgrounds of buttons, cards or pages
- Raw hex in components
- A second decorative accent (`--status-info` is for info, not "edit")
- A new `text-[Npx]` size or `md:` pair instead of a type-scale role
- A new local `StatusBadge` or hand-rolled `fixed inset-0` sheet

## Review Checklist

1. **Corners** — anything rounded? Remove it.
2. **Shadows** — any blur? Replace with `var(--card-shadow)` or a Tailwind hard offset.
3. **Colors** — all tokens? Every non-neutral colour semantic? Accent *text* uses `--accent-text`?
4. **Type** — a §3 role, mono, ≥ 11px on mobile?
5. **Theme** — works in Night and Day?
6. **Primitives** — chips, sheets, sections, disclosures from the shared layer? Nav from `NAV_ITEMS` (`lib/nav-config.tsx`)?
7. **Copy** — headlines in plain words?
8. **Restraint** — would removing an element improve it?

## Source of Truth

- **Design reference**: `docs/design/design-system.md`
- **Canonical CSS tokens**: `apps/web/src/app/globals.css`
- **Tailwind config**: `apps/web/tailwind.config.ts`
- **Mobile layout spec** (sections, data mapping, artboards): `docs/design/mobile-feed-spec.md`
- `references/*.md` are pointers to the design reference, kept so old links resolve.
