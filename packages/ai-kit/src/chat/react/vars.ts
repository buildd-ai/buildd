/**
 * The CSS custom properties the kit's components read, in one place so the
 * phone sheet (portaled to <body>) can carry the values it had where it was
 * opened.
 *
 * `--kit-sheet-bottom-offset`: the height of app chrome fixed to the bottom of
 * the screen (a tab bar), including any safe-area inset it already pads. The
 * phone sheet sits above it. Default 0px.
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
] as const;
export type KitCssVar = (typeof KIT_CSS_VARS)[number];
