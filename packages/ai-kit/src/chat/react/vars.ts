/**
 * The CSS custom properties the kit's components read, in one place so the
 * phone sheet (portaled to <body>) can carry the values it had where it was
 * opened.
 *
 * `--kit-sheet-bottom-offset`: the height of app chrome fixed to the bottom of
 * the screen (a tab bar), including any safe-area inset it already pads. The
 * phone sheet sits above it. Default 0px.
 *
 * `--kit-scrim` (0.8.0): the phone sheet's scrim. Unset, it is mixed from
 * `--kit-ink` as before, which reads as a light wash in a dark theme; a dark
 * theme sets it, e.g. `rgb(0 0 0 / 0.5)`.
 */
/** Map them once from the app's tokens. */
export const KIT_CSS_VARS = [
  '--kit-bg',
  '--kit-surface',
  '--kit-ink',
  '--kit-muted',
  '--kit-rule',
  '--kit-accent',
  '--kit-accent-ink',
  '--kit-radius-soft',
  '--kit-radius-hard',
  '--kit-font-body',
  '--kit-font-mono',
  '--kit-sheet-bottom-offset',
  '--kit-scrim',
] as const;
export type KitCssVar = (typeof KIT_CSS_VARS)[number];
