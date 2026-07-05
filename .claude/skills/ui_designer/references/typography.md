> **DRIFT WARNING (2026-07):** Parts of this file predate the brutalist redesign (#892/#894/#907). Where values disagree with `apps/web/src/app/globals.css` or `docs/design/mobile-feed-spec.md`, those win: accent is `#f4811f` (not copper `#c8956a`), corner radius is 0 (not 6-14px), shadows are hard offsets (`5px 5px 0 0`, blur 0), and headings/labels are IBM Plex Mono.

# Buildd Typography

Three font families, each with a specific role. Never mix roles.

## Font Stack

### Outfit — UI Primary
- **CSS Variable**: `--font-outfit`
- **Role**: Headings, navigation, labels, body text, buttons — all product UI text
- **Character**: Clean geometric sans-serif with warmth. Friendly without being childish.
- **Weights used**: 400 (body paragraphs), 500 (labels/buttons), 600 (headings)
- **Letter-spacing**: Slightly tighter at large sizes (tight tracking at 28px+)
- **Variable weight**: Yes — supports continuous weight range

### IBM Plex Mono — Code & Data
- **CSS Variable**: `--font-ibm-plex-mono`
- **Role**: Code, technical values, timestamps, IDs, section labels, badges, metadata
- **Character**: Technical monospace. Signals "this is data" or "this is a label."
- **Weights used**: 400 (data display, timestamps), 500 (badges, section labels)
- **Letter-spacing**: 2px in uppercase section labels; 0.8px in mission type labels

### Fraunces — Marketing Display Only
- **CSS Variable**: `--font-fraunces`
- **Role**: Hero statements, pull quotes on marketing/landing pages
- **Character**: Elegant, literary serif with warmth.
- **NEVER use in the product UI.** Only landing pages, about pages, marketing material.
- **Style**: 400 italic for display usage

## Type Scale

| Role | Font | Size | Weight | Letter-spacing | Color Token |
|------|------|------|--------|---------------|-------------|
| Page Title | Outfit | 28px | 600 | tight | `--text-primary` |
| Section Heading | Outfit | 18px | 600 | normal | `--text-primary` |
| Card Title / H3 | Outfit | 15px | 600 | normal | `--text-primary` |
| Body / UI Label | Outfit | 13px | 500 | normal | `--text-primary` |
| Body paragraph | Outfit | 14px | 400 | normal | `--text-secondary` |
| Small body | Outfit | 12px | 400 | normal | `--text-secondary` |
| Section label | IBM Plex Mono | 11px | 500 | 2px | `--text-muted` |
| Mission type label | IBM Plex Mono | 9px | 500 | 0.8px | varies by type |
| Status badge | IBM Plex Mono | 11px | 500 | normal | status color |
| Meta / Timestamp | IBM Plex Mono | 11px | 400 | normal | `--text-muted` |
| Code values | IBM Plex Mono | 12px | 400 | normal | `--text-secondary` |
| Marketing hero | Fraunces | 36px+ | 400 italic | 0.5px | `--text-primary` |

## Section Label Pattern

Used throughout the UI to label sections. Distinctive and consistent:

```css
.section-label {
  font-family: var(--font-ibm-plex-mono);
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 2px;
  color: var(--text-muted);
}
```

## Mission Type Label Pattern

Smaller variant for categorizing mission types:

```css
.mission-type-label {
  font-family: var(--font-ibm-plex-mono);
  font-size: 9px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.8px;
}
/* Build = --status-success, Watch = --status-warning, Brief = --accent-text */
```

## Line Heights

| Context | Line-height |
|---------|-------------|
| Body default | 1.6 |
| Paragraphs | 1.7 |
| Code blocks | 1.8 |
| Headings | 1.2-1.3 |
| Single-line labels | 1 |

## Font Smoothing

Always apply antialiased rendering:
```css
-webkit-font-smoothing: antialiased;
```
