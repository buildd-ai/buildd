# Buildd UI Designer

Apply the buildd brand identity to all UI work. **Brutalist/editorial control-room**: square corners, hard offset shadows, mono headings, one orange accent. "Everything has a place — the borders do the talking."

Canonical spec: `docs/design/mobile-feed-spec.md`. Executable source of truth: `apps/web/src/app/globals.css`.

## Quick Rules

1. **Color = Meaning** — Only the accent + status colors are bright. Everything else is warm neutrals. No gradients, ever.
2. **Surfaces (dark)** — `#1a1816` > `#211f1c` > `#2a2724` > `#302c28` (warm charcoal, never pure black). Light: `#e7e3db` paper, `#ffffff` cards.
3. **Accent** — `#f4811f` (classic Apple orange) for CTAs, active states, progress fills. For accent *text on light*, use `--accent-text`/`--accent-deep` (`#b5450c`) — pure orange fails small-text contrast.
4. **Status** — success/warning/error/info tokens only (`--status-*`). Never as decorative button/card backgrounds.
5. **Fonts** — IBM Plex Mono (headings, labels, data, meta — the default voice), Outfit (long-form body), Fraunces (marketing only, never product UI).
6. **Themes** — Day/Night via `[data-theme]` on `:root`. Always use CSS vars, never hardcode hex.
7. **Corners** — **radius 0 everywhere.** Tailwind `rounded-sm/md/lg/xl` map to 0; never use `rounded-full`/`rounded-[Npx]` on surfaces or buttons.
8. **Shadows** — hard offset only: `var(--card-shadow)` = `5px 5px 0 0` solid, blur 0. Never `shadow-md`/`shadow-lg`/soft blur.
9. **Cards** — `var(--card)` bg + **2px `var(--border-strong)` border** + `var(--card-shadow)`. Use the `.card` utility.
10. **Buttons** — primary: `bg-primary text-white hover:bg-primary-hover`, square. Secondary: `bg-surface-3` + `border-border-strong`. No status-color buttons.

## Reference Files

Load as needed:

| File | Contents |
|------|----------|
| `references/tokens.md` | Full design token table (colors, spacing, radius) |
| `references/typography.md` | Font stack, type scale, hierarchy |
| `references/components.md` | Button, badge, input, card, sidebar, nav specs |

**If a reference file contradicts `globals.css`, `globals.css` wins** — flag the drift instead of following the stale doc.
