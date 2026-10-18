/**
 * Due-queue name (`buildd:due:pr-landing`) the PR landing sweep's gated tick reads.
 *
 * Lives in core so the workflow kernel can wake landing without importing the
 * landing sweep module; `pr-landing-sweep.ts` re-exports it.
 */
export const PR_LANDING_DUE_QUEUE = 'pr-landing';
