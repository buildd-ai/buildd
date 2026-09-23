/**
 * The responder's contract types.
 *
 * ── Why the detector signature looks like this ──────────────────────────────
 * `Detector.evaluate` is **synchronous**, takes a plain snapshot plus `now`,
 * and is handed no client of any kind. That is not stylistic. The design
 * requirement is "every detector must be evaluable without a model call", and
 * a requirement enforced by a comment is a requirement that lasts until the
 * next person is in a hurry. With this signature a detector *cannot* reach a
 * model, a database, or the network: there is nothing to reach them with, and
 * a synchronous function cannot await one either.
 *
 * The model's only job in this app is turning a Verdict into prose
 * (`narrative.ts`), downstream of the verdict and downstream of the decision
 * to page. Its absence costs the prose and nothing else.
 */

/**
 * What a detector concluded.
 *
 * Four states, not two, because "I could not tell" is a real answer and
 * collapsing it into `clear` is how a monitor reports health while blind.
 *
 *  - `clear`   — evaluated, condition absent. Silent; clears any prior page.
 *  - `firing`  — condition present. Pages on onset.
 *  - `blind`   — the input this detector needs is missing or stale *when it
 *                should have been present*. Pages, under its own condition key.
 *                A monitor that has never failed is indistinguishable from one
 *                that cannot, so a monitor that cannot see has to say so.
 *  - `warming` — not enough history yet, and not enough time has passed for
 *                that to be surprising (e.g. the first minutes after start).
 *                Deliberately silent and self-clearing; recorded, never paged.
 */
export type DetectorState = 'clear' | 'firing' | 'blind' | 'warming';

export interface Verdict {
  /** Detector id this verdict came from. */
  detector: string;
  state: DetectorState;
  /**
   * The paging identity of this verdict — the key the onset/renotify window is
   * kept against. `firing` and `blind` get different keys so a detector going
   * blind mid-outage does not read as the outage clearing, and vice versa.
   */
  conditionKey: string;
  /**
   * One line, written by code, never by a model. This is what a page says when
   * the narrative is unavailable, so it has to carry the condition and enough
   * to act on: what tripped and since when.
   */
  summary: string;
  /**
   * When the condition began, as far as the evidence shows. Null only when the
   * state carries no onset (`clear` / `warming`).
   */
  onsetAt: string | null;
  /** The deterministic facts behind the verdict. Serialized into evidence. */
  facts: Record<string, unknown>;
}

/**
 * One sample of the claim endpoint, taken by the deliberately-unclaimable
 * probe in `probes/claim-probe.ts`.
 *
 * `status` is null exactly when the request never got a response (DNS,
 * connection refused, timeout) — see `transport`.
 */
export interface ClaimSample {
  at: string;
  status: number | null;
  latencyMs: number;
  transport: 'responded' | 'unreachable';
  /** Why the sample was recorded as unreachable. Never a response body. */
  transportError?: string;
}

/**
 * A `cron_runs` row, read-only. Column names mirror the table so a reader can
 * check them against `packages/core/db/schema.ts` without a translation step.
 */
export interface CronRunRow {
  job: string;
  started_at: string;
  finished_at: string | null;
  ok: boolean;
  processed: number | null;
  changed: number | null;
  errors: number | null;
  result: Record<string, unknown> | null;
  alerted_at: string | null;
}

/** Result of a plain GET against a version endpoint. */
export interface VersionSample {
  reachable: boolean;
  status: number | null;
  latencyMs: number;
  /** Whatever identifying fields the endpoint returned, verbatim-ish. */
  body: Record<string, unknown> | null;
  error?: string;
}

/**
 * Everything one cycle observed. Detectors see only this.
 *
 * Each field is nullable-by-absence: a source the operator did not configure,
 * or one that failed this cycle, is `null` rather than a fabricated empty
 * value — a detector must be able to tell "nothing queued" from "I could not
 * ask", which is the same distinction `DetectorState.blind` exists for.
 */
export interface Snapshot {
  /** Wall clock for the cycle, ISO. */
  at: string;
  /** Claim-probe samples inside the retention window, oldest first. */
  claimSamples: ClaimSample[];
  /** Read-only `cron_runs` rows, or null when the feed could not be read. */
  cronRuns: CronRunRow[] | null;
  /** Why `cronRuns` is null, when it is. */
  cronRunsError?: string;
  /** The platform's public version endpoint. */
  appVersion: VersionSample | null;
  /** The runner's local HTTP port. */
  runnerVersion: VersionSample | null;
  /**
   * Oldest claim sample the responder has ever retained, ISO, or null when it
   * has none. Stands in for "how long have I been watching" — the only way a
   * detector can tell a cold start from a probe that has stopped recording.
   */
  samplingSince: string | null;
}

export interface Detector {
  readonly id: string;
  /** A sentence for the README and for the page body. */
  readonly describes: string;
  /**
   * Pure. No I/O, no model, no `Date.now()` — `now` is passed in so a verdict
   * is reproducible from a snapshot.
   */
  evaluate(snapshot: Snapshot, now: number): Verdict;
}
