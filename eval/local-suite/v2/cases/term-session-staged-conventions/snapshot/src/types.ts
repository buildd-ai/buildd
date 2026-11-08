export type Level = 'INFO' | 'WARN' | 'ERROR';

export interface Entry {
  /** ISO-8601 timestamp, exactly as it appears in the log line. */
  at: string;
  level: Level;
  service: string;
  message: string;
}

export interface Summary {
  total: number;
  byLevel: Record<Level, number>;
  /** ERROR entries whose time is within the 24 hours up to and including `now`. */
  recentErrors: number;
  /** Distinct services that logged at least one ERROR, sorted. */
  errorServices: string[];
}
