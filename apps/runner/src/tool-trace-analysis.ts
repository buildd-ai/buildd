/**
 * Deterministic, versioned analyser over a local tool trace.
 *
 * Every finding carries the call ids and sequence numbers that support it. The
 * rules are structural and conservative: a heuristic, never ground truth, and
 * deliberately NOT a "wasted calls" score. There is no call-count threshold
 * that grades a session, and no retrieved-path / touched-path overlap (that
 * proxy was measured and rejected). A repeat after a file changed, a retry
 * after a failed call, and a later successful check are all legitimate and
 * produce no finding.
 *
 * Pure: same events in, same findings out. Input events are never mutated.
 */
import {
  ANALYSER_VERSION,
  FAILURE_CLASSES,
  FINDING_KINDS,
  TOOL_EFFICIENCY_SCHEMA_VERSION,
  type FailureClass,
  type FindingKind,
  type ToolEfficiencyAggregate,
} from '@buildd/core/tool-efficiency';
import type { TraceCounters, TraceEvent, TraceHeader, TraceOutcome } from './tool-trace';

export { ANALYSER_VERSION };

export interface EventRef { callId: string; seq: number }

export interface ToolFinding {
  kind: FindingKind;
  /** The calls that make the finding true, in order. Always at least one. */
  evidence: EventRef[];
  reason: string;
  /** `high` = structurally certain given the trace; `medium` = depends on the trace being complete. */
  confidence: 'high' | 'medium';
}

/** Outcomes that mean the call itself failed (as opposed to "found nothing"). */
const FAILED: ReadonlySet<TraceOutcome> = new Set(['error', 'timeout', 'nonzero_unmodeled', 'denied', 'cancelled', 'path_unavailable']);
/** Failures worth requiring a later check for. A failed search or read probe is not. */
const IMPORTANT_CATEGORIES: ReadonlySet<string> = new Set(['test', 'build', 'gh']);
const OK: ReadonlySet<TraceOutcome> = new Set(['ok', 'empty_output']);

/** Calls after which a repeated command is a poll, not a one-off. */
const POLL_MIN_IDENTICAL = 3;
/** A quoting error is "retried" if another shell call follows within this many calls. */
const QUOTING_RETRY_WINDOW = 3;

const ref = (e: TraceEvent): EventRef => ({ callId: e.callId, seq: e.seq });
const isShell = (e: TraceEvent) => e.origin === 'shell';

export function analyseToolTrace(eventsIn: readonly TraceEvent[]): ToolFinding[] {
  const events = [...eventsIn].sort((a, b) => a.seq - b.seq);
  const bySeq = new Map<number, TraceEvent>(events.map((e) => [e.seq, e]));
  const findings: ToolFinding[] = [];
  const claimed = new Set<string>(); // an event is the "later call" of at most one finding

  // 1-3: repeated search / read on unchanged input.
  for (const e of events) {
    if (e.repeat.kind !== 'repeat_unchanged' || e.repeat.priorSeq === undefined) continue;
    const prior = bySeq.get(e.repeat.priorSeq);
    // The prior call's events may have been dropped; then we know it repeated but not what it returned.
    if (prior && !prior.resultObserved) continue;
    if (e.repeat.priorOutcome && (FAILED.has(e.repeat.priorOutcome) || e.repeat.priorOutcome === 'unobserved')) continue; // retry after failure is legitimate
    if (!e.resultObserved) continue;
    const evidence = prior ? [ref(prior), ref(e)] : [ref(e)];
    if (e.category === 'read') {
      findings.push({ kind: 'redundant_read_unchanged', evidence, confidence: prior ? 'high' : 'medium', reason: 'The same file was read again and nothing it covers was written in between.' });
      claimed.add(e.callId);
    } else if (e.category === 'search' || e.category === 'find') {
      if (e.searchRole === 'output_filter') continue;
      const broad = !!prior && (prior.truncated || (prior.limit !== null && (prior.output.lines ?? 0) >= prior.limit));
      if (broad) {
        findings.push({ kind: 'broad_search_rerun_unnarrowed', evidence, confidence: 'high', reason: 'A search whose output was truncated or hit its limit was run again unchanged, with no narrower scope or pattern.' });
      } else {
        findings.push({ kind: 'identical_search_unchanged', evidence, confidence: prior ? 'high' : 'medium', reason: 'An identical search was run again and nothing in its scope was written in between.' });
      }
      claimed.add(e.callId);
    }
  }

  // 4: shell quoting error followed by another shell attempt.
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!isShell(e) || e.parseFailure !== 'unbalanced_quote') continue;
    if (!(e.outcome === 'error' || e.outcome === 'nonzero_unmodeled')) continue; // it ran fine anyway
    const retry = events.slice(i + 1).filter(isShell).slice(0, QUOTING_RETRY_WINDOW)[0];
    if (!retry) continue;
    findings.push({ kind: 'command_quoting_retry', evidence: [ref(e), ref(retry)], confidence: 'medium', reason: 'A shell command with unbalanced quoting failed and another shell command followed straight after.' });
  }

  // 5: the same command, same result, three or more times, with no write between.
  const chains = new Map<string, TraceEvent[]>();
  for (const e of events) {
    if (e.category === 'write') {
      if (OK.has(e.outcome)) chains.clear(); // changed state: later identical polls may see something new
      continue;
    }
    if (!e.callKey || !e.resultDigest || e.category === 'search' || e.category === 'find' || e.category === 'read') continue;
    const k = `${e.callKey}|${e.resultDigest}`;
    // A different result for the same command is new evidence: restart that command's chain.
    for (const key of [...chains.keys()]) if (key.startsWith(`${e.callKey}|`) && key !== k) chains.delete(key);
    const chain = chains.get(k) ?? [];
    chain.push(e);
    chains.set(k, chain);
    if (chain.length === POLL_MIN_IDENTICAL) {
      findings.push({ kind: 'poll_without_new_evidence', evidence: chain.map(ref), confidence: 'high', reason: 'The same command returned identical output three times with nothing written in between.' });
    }
  }

  // 6: an important failure with no later successful check.
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!IMPORTANT_CATEGORIES.has(e.category) || !FAILED.has(e.outcome) || e.outcome === 'denied') continue;
    const later = events.slice(i + 1);
    const verified = later.some((l) => OK.has(l.outcome) && l.resultObserved && (l.callKey === e.callKey || l.category === e.category));
    if (verified) continue;
    findings.push({ kind: 'failure_without_verification', evidence: [ref(e)], confidence: 'medium', reason: 'A test, build or gh call failed and no later call of that kind succeeded in this trace.' });
  }

  return findings.sort((a, b) => a.evidence[a.evidence.length - 1].seq - b.evidence[b.evidence.length - 1].seq || a.kind.localeCompare(b.kind));
}

function pct(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** The bounded structural aggregate: the only analyser output allowed to leave the machine. */
export function buildToolEfficiencyAggregate(input: {
  header: Pick<TraceHeader, 'harness'>;
  events: readonly TraceEvent[];
  counters?: Partial<TraceCounters>;
  findings?: readonly ToolFinding[];
  review?: ToolEfficiencyAggregate['review'];
}): ToolEfficiencyAggregate {
  const findings = input.findings ?? analyseToolTrace(input.events);
  const findingKinds: ToolEfficiencyAggregate['findingKinds'] = {};
  for (const f of findings) findingKinds[f.kind] = (findingKinds[f.kind] ?? 0) + 1;
  const failureClasses: ToolEfficiencyAggregate['failureClasses'] = {};
  const times: number[] = [];
  let unobserved = 0;
  for (const e of input.events) {
    if ((FAILURE_CLASSES as readonly string[]).includes(e.outcome)) {
      const c = e.outcome as FailureClass;
      failureClasses[c] = (failureClasses[c] ?? 0) + 1;
    }
    if (!e.resultObserved) unobserved++;
    if (e.elapsedMs !== null) times.push(e.elapsedMs);
  }
  times.sort((a, b) => a - b);
  const c = input.counters ?? {};
  const sampledOut = c.sampledOut ?? 0;
  const dropped = (c.droppedByEventCap ?? 0) + (c.droppedByByteCap ?? 0) + sampledOut;
  return {
    schemaVersion: TOOL_EFFICIENCY_SCHEMA_VERSION,
    analyserVersion: ANALYSER_VERSION,
    harness: input.header.harness,
    calls: input.events.length,
    findingKinds,
    failureClasses,
    timing: {
      observedCalls: times.length,
      totalMs: times.reduce((a, b) => a + b, 0),
      p50Ms: pct(times, 50), p90Ms: pct(times, 90), maxMs: times.length ? times[times.length - 1] : null,
    },
    coverage: { recorded: c.recorded ?? input.events.length, dropped, unobserved, sampledOut },
    ...(input.review ? { review: input.review } : {}),
  };
}

export { FINDING_KINDS };
