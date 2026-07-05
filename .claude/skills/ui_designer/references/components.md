> **DRIFT WARNING (2026-07):** Parts of this file predate the brutalist redesign (#892/#894/#907). Where values disagree with `apps/web/src/app/globals.css` or `docs/design/mobile-feed-spec.md`, those win: accent is `#f4811f` (not copper `#c8956a`), corner radius is 0 (not 6-14px), shadows are hard offsets (`5px 5px 0 0`, blur 0), and headings/labels are IBM Plex Mono.

# Buildd Component Patterns

Detailed specs for recurring UI patterns. All values reference the design token system. Every component works in both dark and light themes via CSS custom properties.

## Cards

The foundational container element. Warm, subtle, never heavy.

```css
.card {
  background: var(--card);               /* #2a2724 dark, #ffffff light */
  border: 1px solid var(--card-border);  /* rgba warm tint */
  border-radius: var(--radius-lg);       /* 14px */
  box-shadow: var(--card-shadow);        /* 0 1px 4px ... */
  transition: all 0.2s ease;
}
.card:hover {
  background: var(--card-hover);         /* #302c28 dark, #fdfcfa light */
  transform: translateY(-0.5px);
}
```

### Card Variants
| Variant | Token | Dark | Light |
|---------|-------|------|-------|
| Default | `--card` | `#2a2724` | `#ffffff` |
| Hover | `--card-hover` | `#302c28` | `#fdfcfa` |
| Finding | `--card-finding` | `#252220` | `#faf8f5` |
| Right Now | `--card-rightnow` | `#1f1d1a` | `#f5f2ee` |

## Buttons

### Primary Button
```css
.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 18px;
  border-radius: var(--radius-sm);       /* 6px */
  font-size: 13px;
  font-weight: 500;
  font-family: var(--font-outfit);
  background: var(--primary);            /* #c8956a */
  color: white;
  border: none;
  cursor: pointer;
  transition: all 0.15s ease;
}
.btn-primary:hover {
  background: var(--primary-hover);      /* #b8854f dark, #b07d4f light */
}
```

### Secondary Button
```css
.btn-secondary {
  /* Same layout as primary, plus: */
  background: var(--surface-3);          /* #2a2724 dark, #e5dfd8 light */
  color: var(--text-primary);            /* #ede8e2 dark, #2a2520 light */
  border: 1px solid var(--border);
}
.btn-secondary:hover {
  background: var(--surface-4);          /* #302c28 dark, #dbd4cc light */
}
```

### Ghost Button
```css
.btn-ghost {
  background: transparent;
  color: var(--text-secondary);          /* #a89f96 dark, #6b6258 light */
  border: none;
}
.btn-ghost:hover {
  color: var(--text-primary);
  background: var(--primary-subtle);     /* rgba(200,149,106,0.08) */
}
```

### Small Variant
```css
.btn-sm {
  padding: 5px 12px;
  font-size: 12px;
}
```

## Status Badges

Pill-shaped indicators with a colored dot. The **primary vehicle for color** in the UI.

```css
.badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 100px;                 /* pill shape */
  font-size: 11px;
  font-weight: 500;
  font-family: var(--font-ibm-plex-mono);
  letter-spacing: 0.02em;
}
.badge-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
```

### Badge Variants

Background is always the status color at 10% opacity. Text color matches the status token.

| Variant | Text Color | Dot Glow (dark) |
|---------|-----------|-----------------|
| Success | `var(--status-success)` | `0 0 10px rgba(94,196,149,0.4)` |
| Running | `var(--status-running)` | `0 0 10px rgba(200,149,106,0.4)` + pulse |
| Warning | `var(--status-warning)` | `0 0 10px rgba(224,179,90,0.4)` |
| Error | `var(--status-error)` | `0 0 10px rgba(212,115,106,0.4)` |
| Info | `var(--status-info)` | `0 0 10px rgba(122,172,202,0.4)` |
| Neutral | `var(--text-secondary)` | none |

Light mode: use 0.25 alpha instead of 0.4 for all glow values.

### Running Dot Pulse Animation
```css
@keyframes glow-pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 10px rgba(200, 149, 106, 0.4); }
  50% { opacity: 0.6; box-shadow: 0 0 16px rgba(200, 149, 106, 0.6); }
}
.badge-running .badge-dot {
  animation: glow-pulse 1.5s ease-in-out infinite;
}
```

## Glow Dots

Standalone status indicators used outside of badges.

```css
.glow-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.glow-dot.success {
  background: var(--status-success);
  box-shadow: 0 0 10px rgba(94, 196, 149, 0.4);
}
.glow-dot.running {
  background: var(--status-running);
  box-shadow: 0 0 10px rgba(200, 149, 106, 0.4);
  animation: glow-pulse 1.5s ease-in-out infinite;
}
.glow-dot.error {
  background: var(--status-error);
  box-shadow: 0 0 10px rgba(212, 115, 106, 0.4);
}
/* Light mode: 0.25 alpha instead of 0.4 */
```

## Form Inputs

```css
.input {
  width: 100%;
  padding: 9px 14px;
  background: var(--surface-1);          /* #1a1816 dark, #f7f4f0 light */
  border: 1px solid var(--border);       /* warm-tinted transparent */
  border-radius: var(--radius-sm);       /* 6px */
  color: var(--text-primary);
  font-family: var(--font-outfit);
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.input:focus {
  border-color: var(--primary);          /* #c8956a */
  box-shadow: 0 0 0 3px var(--primary-ring); /* rgba(200,149,106,0.25) */
}
.input::placeholder {
  color: var(--text-muted);
}
```

### Input Labels
```css
.input-label {
  font-size: 12px;
  font-weight: 500;
  font-family: var(--font-outfit);
  color: var(--text-secondary);
  margin-bottom: 6px;
  display: block;
}
```

## Section Labels

The distinctive monospace uppercase pattern used to label UI sections.

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

## Mission Type Labels

Smaller monospace labels for mission categories (Build, Watch, Brief).

```css
.mission-type-label {
  font-family: var(--font-ibm-plex-mono);
  font-size: 9px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.8px;
}
/* Color by type:
   Build  = var(--status-success)
   Watch  = var(--status-warning)
   Brief  = var(--accent-text)
*/
```

## Mission Cards

Cards with a left border indicating mission type.

```css
.mission-card {
  /* Standard card styles, plus: */
  border-left: 2px solid var(--status-success); /* Build */
}
/* Watch: border-left-color: var(--status-warning) */
/* Brief: border-left-color: var(--accent-text) */
```

## Sidebar (MissionsSidebar)

Collapsed icon rail on desktop. Lean and functional.

```css
.sidebar {
  width: 56px;
  background: var(--chrome-sidebar);     /* #15130f dark, #eee9e3 light */
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px 0;
}
.sidebar-icon-btn {
  width: 40px;
  height: 40px;
  border-radius: var(--radius-md);       /* 10px */
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  transition: all 0.15s ease;
}
.sidebar-icon-btn:hover {
  color: var(--text-primary);
  background: var(--surface-3);
}
.sidebar-icon-btn.active {
  color: var(--accent-text);             /* #d4a574 dark, #b07d4f light */
}
```

Bottom of sidebar: ThemeToggle button + user avatar.

## Bottom Nav (MissionsBottomNav)

Mobile navigation. Fixed to bottom of viewport.

```css
.bottom-nav {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: 56px;
  background: var(--chrome-bg);          /* rgba with 0.92 opacity */
  backdrop-filter: blur(12px);
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-around;
}
/* Visible only on mobile: md:hidden */
```

## Stat Cards

Dashboard metric cards arranged in a grid.

```css
.stat-card {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);       /* 10px */
  padding: 16px;
}
.stat-label {
  font-size: 10px;
  font-family: var(--font-ibm-plex-mono);
  text-transform: uppercase;
  letter-spacing: 1.5px;
  color: var(--text-muted);
  margin-bottom: 6px;
}
.stat-value {
  font-size: 24px;
  font-weight: 600;
  font-family: var(--font-outfit);
  color: var(--text-primary);
}
```

## Grain Texture

Optional atmospheric SVG noise overlay, applied via pseudo-element.

```css
.grain::after {
  content: '';
  position: absolute;
  inset: 0;
  opacity: 0.03;
  pointer-events: none;
  background-image: url("data:image/svg+xml,..."); /* SVG noise */
}
```

## Transitions

Standard transition values used throughout:

| Context | Value |
|---------|-------|
| Interactive elements | `all 0.15s ease` |
| Hover background | `background 0.1s ease` |
| Border/shadow changes | `border-color 0.15s ease, box-shadow 0.15s ease` |
| Card hover lift | `transform 0.2s ease, box-shadow 0.2s ease` |

Card hover lift: `translateY(-0.5px)` — subtle, not dramatic.
