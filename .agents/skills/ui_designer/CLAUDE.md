# Buildd UI Designer

Apply the buildd brand identity to all UI work. **Brutalist/editorial control-room**: square corners, hard offset shadows, mono everywhere, one orange accent. "Everything has a place — the borders do the talking."

**One file to read: `docs/design/design-system.md`** — direction, tokens, type scale, primitives, copy rules. Executable source of truth: `apps/web/src/app/globals.css` + `apps/web/tailwind.config.ts`; if anything disagrees, `globals.css` wins.

## Quick Rules

1. **Color = Meaning** — only the accent and status colours are bright; no gradients.
2. **Tokens only** — `bg-surface-*`, `bg-card`, `text-text-*`, `border-border-*`, `*-status-*`, `*-accent*`. Never raw hex.
3. **Accent text** — use `--accent-text` (`text-accent-text`); pure orange fails small-text contrast on Day.
4. **Corners 0, shadows hard** — no `rounded-[Npx]`, no blur.
5. **Type scale** — a design-system §3 role, not `text-[Npx]`; nothing under 11px on mobile.
6. **Primitives** — Chip, Eyebrow, Section, Lede, PrimaryAction, Disclosure, Sheet (design-system §4); don't hand-roll chips or sheets.
7. **Copy** — plain words in headlines; no paths, symbols or PR numbers (design-system §5).

`references/*.md` now only point at the design reference.
