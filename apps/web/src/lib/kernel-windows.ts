/** The windows the operator's kernel view offers. No I/O, so a client component can import it. */
export const KERNEL_WINDOWS = { '24h': 24 * 3_600_000, '7d': 7 * 24 * 3_600_000 } as const;
export type KernelWindow = keyof typeof KERNEL_WINDOWS;
export const KERNEL_WINDOW_LABEL: Record<KernelWindow, string> = { '24h': 'last 24 hours', '7d': 'last 7 days' };

/** How many transitions the recent list shows. */
export const TRANSITION_LIMIT = 50;
