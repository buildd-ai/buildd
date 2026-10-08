/** Worker-attributed usage in an Insights window. */
export interface InsightsUsageRow {
  role: string;
  /** Recorded task model tier; null means it was not recorded. */
  tier: string | null;
  /** Input plus output tokens for runs started in the window. */
  tokens: number;
  /** Recorded worker cost for runs started in the window. */
  costUsd: number;
  /** Run time overlapping the window, including workers already active. */
  hours: number;
  /**
   * How this worker's tokens and cost were charged (docs/specs/real-and-virtual-cost.md).
   * Null when the worker recorded no usage. Absent on rows built before the split.
   */
  basis?: 'real' | 'virtual' | 'mixed' | 'unknown' | null;
  /** Who ran it: an interactive session, a runner, or a placeholder worker. */
  executor?: 'interactive' | 'runner' | 'other';
}
