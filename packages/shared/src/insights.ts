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
}
