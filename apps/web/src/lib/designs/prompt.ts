/**
 * The builder's design section ("Designs in buildd" R-10/AC-7): the task's
 * design, else its mission's, else its spec's, naming the screens the spec
 * criteria name. The text lives in @buildd/shared so the runner prompt and
 * this seam say the same thing; the claim resolves the inputs
 * (lib/design-source.ts).
 */
export { designPromptSection } from '@buildd/shared';
