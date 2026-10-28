/**
 * Compare one replayed step with the recorded one.
 *
 * A decision is the transition (command, states, versions, idempotency key,
 * actor, evidence, bypass) plus the effects its statement enqueued (kind,
 * dedupe key, payload). Volatile identity is mapped before comparing: the
 * replay's delivery row and fact rows get fresh ids, which `idMap` turns back
 * into the recorded ones. Scheduling (`not_before`) and drain status are not
 * decisions and are not compared.
 */

import { ROUND_TRIGGERS } from '@buildd/workflow-kernel';

type J = Record<string, unknown>;

export interface StepDecision {
  transition: {
    command: string; fromState: string | null; toState: string; fromVersion: number; toVersion: number;
    idempotencyKey: string; actor: string; evidence: J; bypass: J | null;
  } | null;
  effects: Array<{ kind: string; dedupeKey: string; payload: J }>;
}

/** Replace every occurrence of a mapped id, inside any string, at any depth. */
export function remapIds<T>(value: T, idMap: Map<string, string>): T {
  if (idMap.size === 0) return value;
  const ids = [...idMap.keys()].filter((k) => k.length > 0);
  const swap = (s: string): string => ids.reduce((acc, k) => (acc.includes(k) ? acc.split(k).join(idMap.get(k)!) : acc), s);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return swap(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as J).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** Stable JSON: object keys sorted, `undefined` dropped, so key order never reads as a divergence. */
export function canonical(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') {
      return Object.fromEntries(Object.keys(x as J).sort().filter((k) => (x as J)[k] !== undefined).map((k) => [k, norm((x as J)[k])]));
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

export interface Divergence {
  /** Dotted path of the first field that differs, e.g. `transition.toState`, `effects[dispatch_review:...]`. */
  field: string;
  recorded: unknown;
  replayed: unknown;
}

const TRANSITION_FIELDS = ['command', 'fromState', 'toState', 'fromVersion', 'toVersion', 'idempotencyKey', 'actor', 'evidence', 'bypass'] as const;

/** The first difference between two decisions, or null when they are the same decision. */
export function firstDivergence(recorded: StepDecision, replayed: StepDecision): Divergence | null {
  const r = recorded.transition;
  const p = replayed.transition;
  if (!r || !p) {
    if (r || p) return { field: 'transition', recorded: r ? summary(r) : null, replayed: p ? summary(p) : null };
  } else {
    for (const f of TRANSITION_FIELDS) {
      if (canonical(r[f] ?? null) !== canonical(p[f] ?? null)) return { field: `transition.${f}`, recorded: r[f] ?? null, replayed: p[f] ?? null };
    }
  }
  const byKey = (xs: StepDecision['effects']) => new Map(xs.map((e) => [e.dedupeKey, e]));
  const re = byKey(recorded.effects);
  const pe = byKey(replayed.effects);
  for (const k of [...new Set([...re.keys(), ...pe.keys()])].sort()) {
    const a = re.get(k);
    const b = pe.get(k);
    if (!a || !b) return { field: `effects[${k}]`, recorded: a ? a.kind : null, replayed: b ? b.kind : null };
    if (a.kind !== b.kind) return { field: `effects[${k}].kind`, recorded: a.kind, replayed: b.kind };
    if (canonical(a.payload) !== canonical(b.payload)) return { field: `effects[${k}].payload`, recorded: a.payload, replayed: b.payload };
  }
  return null;
}

/** One line a person reads: what the step decided. */
export function summary(t: NonNullable<StepDecision['transition']>): string {
  return `${t.command}: ${t.fromState ?? 'none'} -> ${t.toState} (v${t.toVersion}, ${t.idempotencyKey})`;
}

/**
 * A decision the current kernel makes differently ON PURPOSE, recognised by its
 * exact shape so the replay can compare the rest of the step. Each one names
 * the PR that changed it and the spec text that requires the new shape; it may
 * only ADD what that PR added, on the transition that PR changed, and only
 * where the old and new decisions are otherwise the same decision. Anything
 * else stays a divergence.
 */
export interface KnownEvolution {
  id: string;
  /** Rewrite `replayed` to what the recording's code would have written, or return null when the shape does not match. */
  apply(recorded: StepDecision, replayed: StepDecision): StepDecision | null;
}

const isObj = (v: unknown): v is J => !!v && typeof v === 'object' && !Array.isArray(v);

/** The same transition (command, states, key) on both sides, or none on both: an evolution may only add to the same decision. */
function sameDecision(recorded: StepDecision, replayed: StepDecision): boolean {
  const r = recorded.transition;
  const p = replayed.transition;
  if (!r || !p) return !r && !p;
  return r.command === p.command && r.toState === p.toState && (r.fromState ?? null) === (p.fromState ?? null) && r.idempotencyKey === p.idempotencyKey;
}

export const KNOWN_EVOLUTIONS: KnownEvolution[] = [
  {
    // a90fc99b (#4245, spec §13.7 item 9): a treadmill cycle the landing sweep restarts after
    // the cooldown is Buildd's wait, not a page, so only the final cycle notifies a person.
    // Before cycles every treadmill escalation notified; a recording from then is cycle 1. On a
    // cycle-1, non-final escalation the replay may carry exactly the recorded
    // `notify:…:treadmill:<head>` landing_needs_human effect it no longer enqueues, and nothing
    // else. Runs before the #4072 rule, which strips the cycle this one reads.
    id: 'treadmill notifies only on the final cycle (a90fc99b #4245, spec §13.7 item 9)',
    apply(recorded, replayed) {
      const p = replayed.transition;
      if (!p || p.command !== 'ConflictObserved' || !p.idempotencyKey.endsWith(':treadmill') || p.toState !== 'ESCALATED' || !sameDecision(recorded, replayed)) return null;
      if (!isObj(p.evidence) || p.evidence.treadmill !== true || p.evidence.cycle !== 1 || 'finalCycle' in p.evidence) return null;
      const replayedKeys = new Set(replayed.effects.map((e) => e.dedupeKey));
      const missing = recorded.effects.filter((e) => e.kind === 'notify' && /^notify:[^:]+:treadmill:[^:]+$/.test(e.dedupeKey)
        && isObj(e.payload) && e.payload.event === 'landing_needs_human' && !replayedKeys.has(e.dedupeKey));
      return missing.length === 1 ? { ...replayed, effects: [...replayed.effects, missing[0]] } : null;
    },
  },
  {
    // #4072 (S15 cycles): a spent treadmill's ESCALATED(landing_needs_human) evidence
    // carries `treadmill: true` and the cycle number (spec §13.7 item 9). Before it
    // there were no cycles, so a recording without them is cycle 1, never the final
    // cycle: the replay may add exactly `treadmill: true, cycle: 1` and nothing else.
    id: 'treadmill-cycle-evidence (#4072, spec §13.7 item 9)',
    apply(recorded, replayed) {
      const r = recorded.transition;
      const p = replayed.transition;
      if (!r || !p || p.command !== 'ConflictObserved' || !p.idempotencyKey.endsWith(':treadmill') || p.toState !== 'ESCALATED') return null;
      if (!isObj(r.evidence) || !isObj(p.evidence) || 'treadmill' in r.evidence || 'cycle' in r.evidence) return null;
      if (p.evidence.treadmill !== true || p.evidence.cycle !== 1 || 'finalCycle' in p.evidence) return null;
      const { treadmill: _t, cycle: _c, ...rest } = p.evidence;
      return { ...replayed, transition: { ...p, evidence: rest } };
    },
  },
  {
    // 10658a4c: T28's key and every head-bound exhaustion key name the version they were
    // read at (`…@v{N}`, spec §6.3 T7/T28), so a second occurrence after a person resolves
    // back to the same head is not a replay of the first. A recording from before carries
    // the bare key: the replay may drop exactly that suffix, on exactly those keys, when the
    // bare key is the recorded one, and nothing else.
    id: 'version-bound occurrence keys (10658a4c, spec §6.3 T7/T28)',
    apply(recorded, replayed) {
      const r = recorded.transition;
      const p = replayed.transition;
      const suffix = /@v\d+$/;
      const bound = (k: string) => (k.startsWith('policy:') || k.startsWith('exhaust:')) && suffix.test(k);
      let changed = false;
      let transition = p;
      if (r && p && bound(p.idempotencyKey) && p.idempotencyKey.replace(suffix, '') === r.idempotencyKey) {
        transition = { ...p, idempotencyKey: r.idempotencyKey };
        changed = true;
      }
      const recordedKeys = new Set(recorded.effects.map((e) => e.dedupeKey));
      const effects = replayed.effects.map((e) => {
        if (e.kind !== 'escalate_exhaustion' || !bound(e.dedupeKey) || recordedKeys.has(e.dedupeKey)) return e;
        const bare = e.dedupeKey.replace(suffix, '');
        if (!recordedKeys.has(bare)) return e;
        changed = true;
        return { ...e, dedupeKey: bare };
      });
      return changed ? { transition, effects } : null;
    },
  },
  {
    // 10658a4c: a dead dispatch_review escalates as `review_unavailable` (spec §6.3 T22b), which
    // T5 lets anyone retry; before, it was the generic `effect_dead`. Same transition, same
    // effects: the replay may put back exactly the old reason in the evidence and the notice.
    id: 'dead dispatch_review is review_unavailable (10658a4c, spec §6.3 T22b)',
    apply(recorded, replayed) {
      const r = recorded.transition;
      const p = replayed.transition;
      if (!r || !p || p.command !== 'EffectDead' || !isObj(p.evidence) || !isObj(r.evidence)) return null;
      if (p.evidence.effectKind !== 'dispatch_review' || p.evidence.reason !== 'review_unavailable' || r.evidence.reason !== 'effect_dead') return null;
      const effects = replayed.effects.map((e) => (e.kind === 'notify' && isObj(e.payload) && e.payload.reason === 'review_unavailable'
        ? { ...e, payload: { ...e.payload, reason: 'effect_dead' } } : e));
      return { transition: { ...p, evidence: { ...p.evidence, reason: 'effect_dead' } }, effects };
    },
  },
  {
    // S3b (workflow-kernel-library.md §4): every version of a PR delivery owes the
    // `buildd/landing` status effect. A recording from before has none: the replay may
    // drop exactly the publish_landing_status effects the recording lacks, nothing else.
    id: 'buildd/landing status effect (S3b, workflow-kernel-library.md §4)',
    apply(recorded, replayed) {
      if (!sameDecision(recorded, replayed)) return null;
      const recordedKeys = new Set(recorded.effects.map((e) => e.dedupeKey));
      const effects = replayed.effects.filter((e) => e.kind !== 'publish_landing_status' || recordedKeys.has(e.dedupeKey));
      return effects.length !== replayed.effects.length ? { ...replayed, effects } : null;
    },
  },
  {
    // S3b: T15 carries the state it landed from (and a person's override kinds) to the
    // merge effect, which asks the landing gate again; and a door no longer vouches for
    // rails (`rails: { passed: true }` in a recording's evidence). The replay may put the
    // recording's form back on exactly the merge_call payload and the T15 evidence.
    id: 'gate at merge time (S3b, workflow-kernel-library.md §4)',
    apply(recorded, replayed) {
      const p = replayed.transition;
      const r = recorded.transition;
      if (!p || p.command !== 'LandingRequested' || !sameDecision(recorded, replayed)) return null;
      let changed = false;
      const rec = new Map(recorded.effects.map((e) => [e.dedupeKey, e]));
      const effects = replayed.effects.map((e) => {
        const was = rec.get(e.dedupeKey);
        if (e.kind !== 'merge_call' || !isObj(e.payload) || !was || !isObj(was.payload)) return e;
        if ('fromState' in was.payload || !('fromState' in e.payload)) return e;
        const { fromState: _f, override: _o, ...rest } = e.payload;
        if ('override' in was.payload) (rest as J).override = was.payload.override;
        changed = true;
        return { ...e, payload: rest };
      });
      let transition = p;
      if (r && isObj(r.evidence) && isObj(p.evidence) && 'rails' in r.evidence && !('rails' in p.evidence)) {
        transition = { ...p, evidence: { ...p.evidence, rails: r.evidence.rails } };
        changed = true;
      }
      return changed ? { transition, effects } : null;
    },
  },
  {
    // S4b (workflow-kernel-library.md §1, AC-2): T17's statement completes the owner task and
    // writes what it did onto the emit_pr_merged effect's payload (`taskTransition`,
    // `ownerWorkerId`, task-projection.ts). A recording from before carries neither: the replay
    // may drop exactly those two keys from exactly that effect, and only when the recording lacks them.
    id: 'merge task projection on emit_pr_merged (S4b, workflow-kernel-library.md §1)',
    apply(recorded, replayed) {
      if (!sameDecision(recorded, replayed) || replayed.transition?.command !== 'PrMerged') return null;
      const rec = new Map(recorded.effects.map((e) => [e.dedupeKey, e]));
      let changed = false;
      const effects = replayed.effects.map((e) => {
        const was = rec.get(e.dedupeKey);
        if (e.kind !== 'emit_pr_merged' || !isObj(e.payload) || !was || !isObj(was.payload)) return e;
        if ('taskTransition' in was.payload || !('taskTransition' in e.payload)) return e;
        const { taskTransition: _t, ownerWorkerId: _o, ...rest } = e.payload;
        changed = true;
        return { ...e, payload: rest };
      });
      return changed ? { ...replayed, effects } : null;
    },
  },
  {
    // S3b (§13.13 rule 10, AC-15): a merge from outside LANDING is recorded as external,
    // with who merged it, the head, and whether it went over an open verdict, and owes a
    // fix when it did. A recording from before carries none of it: the replay may drop
    // exactly those evidence keys and that one effect from PrMerged, nothing else.
    id: 'external merge record (S3b, workflow-state-kernel.md §13.13 rule 10)',
    apply(recorded, replayed) {
      const p = replayed.transition;
      const r = recorded.transition;
      if (!p || !r || p.command !== 'PrMerged' || !sameDecision(recorded, replayed) || !isObj(p.evidence) || !isObj(r.evidence) || 'external' in r.evidence) return null;
      const extra = ['external', 'mergedBy', 'mergedHead', 'fromState', 'merged_over_open_findings', 'openVerdict'];
      if (!extra.some((k) => k in (p.evidence as J))) return null;
      const evidence = Object.fromEntries(Object.entries(p.evidence).filter(([k]) => !extra.includes(k)));
      const recordedKeys = new Set(recorded.effects.map((e) => e.dedupeKey));
      const effects = replayed.effects.filter((e) => e.kind !== 'dispatch_external_merge_fix' || recordedKeys.has(e.dedupeKey));
      return { transition: { ...p, evidence }, effects };
    },
  },
  {
    // S5 (workflow-kernel-library.md §5): a verdict and a push record what they did to the
    // delivery's findings (`findings`, `addressedFindings`, `unverifiedFindings`; `openFindings`
    // on an external merge). A recording from before findings existed carries none: on the same
    // decision the replay may drop exactly those evidence keys, and nothing else.
    id: 'findings evidence (S5, workflow-kernel-library.md §5)',
    apply(recorded, replayed) {
      const p = replayed.transition;
      const r = recorded.transition;
      if (!p || !r || !sameDecision(recorded, replayed) || !isObj(p.evidence) || !isObj(r.evidence)) return null;
      const keys = ['findings', 'addressedFindings', 'unverifiedFindings', 'openFindings'].filter((k) => k in (p.evidence as J) && !(k in (r.evidence as J)));
      if (keys.length === 0) return null;
      const evidence = Object.fromEntries(Object.entries(p.evidence).filter(([k]) => !keys.includes(k)));
      return { ...replayed, transition: { ...p, evidence } };
    },
  },
  {
    // #4911 (workflow-state-kernel.md §8.3a): every round records why it started, and
    // dispatch_review carries that `trigger`. A recording from before carries none: on the
    // same decision the replay may drop exactly that key, holding a known trigger, from
    // exactly the dispatch_review payloads whose recorded payload lacks it.
    id: 'round trigger on dispatch_review (#4911, workflow-state-kernel.md §8.3a)',
    apply(recorded, replayed) {
      if (!sameDecision(recorded, replayed)) return null;
      const rec = new Map(recorded.effects.map((e) => [e.dedupeKey, e]));
      let changed = false;
      const effects = replayed.effects.map((e) => {
        const was = rec.get(e.dedupeKey);
        if (e.kind !== 'dispatch_review' || !isObj(e.payload) || !was || was.kind !== 'dispatch_review' || !isObj(was.payload)) return e;
        if ('trigger' in was.payload || !(ROUND_TRIGGERS as readonly unknown[]).includes(e.payload.trigger)) return e;
        const { trigger: _t, ...rest } = e.payload;
        changed = true;
        return { ...e, payload: rest };
      });
      return changed ? { ...replayed, effects } : null;
    },
  },
  {
    // #4911 (workflow-state-kernel.md §8.3a): a round after a reviewer's approval is a delta
    // review only when the delta was read and is small; otherwise it is a full review, with
    // the eligibility answer in its scope. Before, every round after an approval at another
    // head was a delta review, and no delta was read. The replay reads none either, so the
    // answer is the unread one (`eligible: false`, no `fromHeadSha`, no size): on the same
    // decision, a recorded `delta` round with no scope may stand for exactly that full round.
    id: 'full review after an approval unless the delta is read (#4911, workflow-state-kernel.md §8.3a)',
    apply(recorded, replayed) {
      if (!sameDecision(recorded, replayed)) return null;
      const rec = new Map(recorded.effects.map((e) => [e.dedupeKey, e]));
      const unread = (s: unknown): boolean => {
        if (!isObj(s) || Object.keys(s).join() !== 'deltaApproval' || !isObj(s.deltaApproval)) return false;
        const a = s.deltaApproval;
        return a.eligible === false && a.fromHeadSha === null && Object.keys(a).every((k) => ['eligible', 'reason', 'fromHeadSha'].includes(k));
      };
      let changed = false;
      const effects = replayed.effects.map((e) => {
        const was = rec.get(e.dedupeKey);
        if (e.kind !== 'dispatch_review' || !isObj(e.payload) || !was || was.kind !== 'dispatch_review' || !isObj(was.payload)) return e;
        if (was.payload.kind !== 'delta' || was.payload.scope != null || e.payload.kind !== 'full' || !unread(e.payload.scope)) return e;
        changed = true;
        return { ...e, payload: { ...e.payload, kind: 'delta', scope: null } };
      });
      return changed ? { ...replayed, effects } : null;
    },
  },
  {
    // #4368 (S15, workflow-state-kernel.md §13.7): a behind refresh records the freshness
    // verdict it went ahead on. A recording from before read no base delta, and neither does
    // the replay, so the verdict is the unread one: on the same decision the replay may drop
    // exactly `freshness: { tolerated: false, cause: 'unread' }` from a ConflictObserved.
    id: 'behind refresh freshness evidence (#4368, workflow-state-kernel.md §13.7 S15)',
    apply(recorded, replayed) {
      const p = replayed.transition;
      const r = recorded.transition;
      if (!p || !r || p.command !== 'ConflictObserved' || !sameDecision(recorded, replayed) || !isObj(p.evidence) || !isObj(r.evidence)) return null;
      if ('freshness' in r.evidence || canonical(p.evidence.freshness) !== canonical({ tolerated: false, cause: 'unread' })) return null;
      const { freshness: _f, ...evidence } = p.evidence;
      return { ...replayed, transition: { ...p, evidence } };
    },
  },
  {
    // S5 (#4815, workflow-kernel-library.md §5): a review budget spent with requested changes
    // still open names them on the escalate_exhaustion effect (`findings`). A recording from
    // before findings existed carries none: on the same decision the replay may drop exactly
    // that key from exactly those effects, when the recorded payload lacks it.
    id: 'findings on escalate_exhaustion (S5 #4815, workflow-kernel-library.md §5)',
    apply(recorded, replayed) {
      if (!sameDecision(recorded, replayed)) return null;
      const rec = new Map(recorded.effects.map((e) => [e.dedupeKey, e]));
      let changed = false;
      const effects = replayed.effects.map((e) => {
        const was = rec.get(e.dedupeKey);
        if (e.kind !== 'escalate_exhaustion' || !isObj(e.payload) || !Array.isArray(e.payload.findings) || !was || !isObj(was.payload) || 'findings' in was.payload) return e;
        const { findings: _f, ...rest } = e.payload;
        changed = true;
        return { ...e, payload: rest };
      });
      return changed ? { ...replayed, effects } : null;
    },
  },
  {
    // a1f31c85 (workflow-state-kernel.md T18, CLOSED_UNMERGED): a close records its cause and,
    // when the webhook or a buildd door named one, who closed it. A recording from before
    // carries neither in the evidence, but its cancel_open_attempts effect already carried
    // the cause: on the same decision the replay may drop exactly `closeCause` (only when it
    // equals that recorded cause) and `closedBy`, and nothing else.
    id: 'close cause and closer evidence (a1f31c85, workflow-state-kernel.md T18)',
    apply(recorded, replayed) {
      const p = replayed.transition;
      const r = recorded.transition;
      if (!p || !r || p.command !== 'PrClosedUnmerged' || !sameDecision(recorded, replayed) || !isObj(p.evidence) || !isObj(r.evidence)) return null;
      if ('closeCause' in r.evidence || 'closedBy' in r.evidence || !('closeCause' in p.evidence)) return null;
      const cancel = recorded.effects.find((e) => e.kind === 'cancel_open_attempts');
      if (!cancel || !isObj(cancel.payload) || cancel.payload.closeCause !== p.evidence.closeCause) return null;
      const { closeCause: _c, closedBy: _b, ...evidence } = p.evidence;
      return { ...replayed, transition: { ...p, evidence } };
    },
  },
];

/**
 * A recorded decision the current kernel makes differently ON PURPOSE, where the
 * difference is the decision itself (another to-state), so no evolution may
 * rewrite it. The delivery stops there as `incomplete`, naming the change: never
 * identical, never tolerated, and never silently a divergence the corpus keeps
 * failing on. Each names the PR that changed it; the shape on both sides must be exact.
 */
export interface SupersededDecision {
  id: string;
  /** `before` is the replayed delivery as the step found it (the same as the recording's, every earlier step having matched). */
  matches(recorded: StepDecision, replayed: StepDecision, before: { state: string; stateReason: string | null } | null): boolean;
}

export const SUPERSEDED_DECISIONS: SupersededDecision[] = [
  {
    // abe42d1b (#4169, spec §9 / §6.9): a fix that ended successfully with nothing local
    // reported and no commits is proven by the push attributed to it mid-attempt, so the
    // kernel starts the next round instead of parking in AWAITING_PUSH(local_head_unknown).
    id: 'a successful fix is proven by its own attributed push (abe42d1b #4169, spec §9)',
    matches(recorded, replayed) {
      const r = recorded.transition;
      const p = replayed.transition;
      if (!r || !p || r.command !== 'AttemptEnded' || p.command !== 'AttemptEnded' || r.idempotencyKey !== p.idempotencyKey) return false;
      if (r.fromState !== 'FIXING' || p.fromState !== 'FIXING' || r.toState !== 'AWAITING_PUSH' || p.toState !== 'AWAITING_REVIEW') return false;
      const e = r.evidence;
      const pe = p.evidence;
      return isObj(e) && isObj(pe) && e.outcome === 'success' && (e.commitCount ?? 0) === 0 && e.localHeadSha == null
        && isObj(e.proof) && e.proof.reason === 'local_head_unknown' && isObj(pe.proof) && pe.proof.holds === true;
    },
  },
  {
    // 2ded4e88 (#4910, spec T5): a spent review budget is final. A push after a
    // review_exhausted escalation used to queue another round; now the head is only recorded
    // and the delivery stays with the person until a person acts.
    id: 'a spent review budget is not re-armed by a push (2ded4e88 #4910, spec T5)',
    matches(recorded, replayed, before) {
      const r = recorded.transition;
      const p = replayed.transition;
      if (!r || !p || r.command !== 'HeadObserved' || p.command !== 'HeadObserved' || r.idempotencyKey !== p.idempotencyKey) return false;
      if (before?.state !== 'ESCALATED' || before.stateReason !== 'review_exhausted') return false;
      return r.fromState === 'ESCALATED' && r.toState === 'AWAITING_REVIEW' && p.fromState === 'ESCALATED' && p.toState === 'ESCALATED'
        && !replayed.effects.some((e) => e.kind === 'dispatch_review');
    },
  },
  {
    // #5796 (spec §6.5): a repair that ended cleanly with nothing local beyond the head it was
    // bound to (its reported head IS the unmoved PR head) used to park in
    // AWAITING_PUSH(head_not_advanced) and end at a person as push_undeliverable; now it is a
    // no-change end at that head.
    id: 'a repair with nothing to push is a no-change end, not AWAITING_PUSH (#5796, spec §6.5)',
    matches(recorded, replayed) {
      const r = recorded.transition;
      const p = replayed.transition;
      if (!r || !p || r.command !== 'AttemptEnded' || p.command !== 'AttemptEnded' || r.idempotencyKey !== p.idempotencyKey) return false;
      if (r.fromState !== 'REPAIRING' || p.fromState !== 'REPAIRING' || r.toState !== 'AWAITING_PUSH' || p.toState === 'AWAITING_PUSH') return false;
      const e = r.evidence;
      const pe = p.evidence;
      return isObj(e) && isObj(pe) && e.outcome === 'success' && isObj(e.proof) && e.proof.reason === 'head_not_advanced' && pe.nothingToPush === true;
    },
  },
  {
    // #5764 (spec §6.5 row `commitCount>0`): an owner attempt that ended cleanly with no commits
    // of its own used to park in AWAITING_PUSH whenever the worktree head it reported was not the
    // PR head (an adopted PR's owner parked on the base); now it hands on at the live head.
    id: 'an owner end with zero commits hands on at the live head (#5764, spec §6.5)',
    matches(recorded, replayed) {
      const r = recorded.transition;
      const p = replayed.transition;
      if (!r || !p || r.command !== 'AttemptEnded' || p.command !== 'AttemptEnded' || r.idempotencyKey !== p.idempotencyKey) return false;
      if (r.fromState !== 'WORKING' || p.fromState !== 'WORKING' || r.toState !== 'AWAITING_PUSH' || p.toState === 'AWAITING_PUSH') return false;
      const e = r.evidence;
      const pe = p.evidence;
      return isObj(e) && isObj(pe) && e.outcome === 'success' && e.commitCount === 0 && typeof e.localHeadSha === 'string' && pe.nothingLocal === true;
    },
  },
];

/**
 * A recorded command the current kernel refuses ON PURPOSE because the input itself
 * is retired, not because it decides differently: no later step can be judged
 * against a state the current code never reaches, so the delivery stops there as
 * `incomplete`, naming the change, never as identical and never as a divergence.
 * Each names the PR that retired the input; the shape must be exact.
 */
export interface RetiredInput {
  id: string;
  matches(t: { command: string; actor: string; bypass: J | null }): boolean;
}

export const RETIRED_INPUTS: RetiredInput[] = [
  {
    // #4189: a forced review request is a person's call (T5 `force_requires_human`), and the
    // route stopped writing the anonymous actor `force` for one. A recording from before has
    // that actor, which says nothing about who asked, so the forced round cannot be rebuilt.
    id: 'anonymous forced review request (#4189, T5 force_requires_human)',
    matches: (t) => t.command === 'ReviewRequested' && t.actor === 'force' && t.bypass?.forced === true,
  },
];

/**
 * Bring the replayed decision into the recording's form before diffing: prose
 * collapsed with the exporter's own rule (both sides, idempotent), then every
 * known evolution whose shape matches. Returns the ids it applied, so the
 * report says which tolerance a delivery needed.
 */
export function normalizeForCompare(
  recorded: StepDecision, replayed: StepDecision, redact: <T>(v: T) => T,
): { recorded: StepDecision; replayed: StepDecision; tolerated: string[] } {
  const rec = redact(recorded);
  let rep = redact(replayed);
  const tolerated: string[] = [];
  if (firstDivergence(rec, rep)) {
    for (const e of KNOWN_EVOLUTIONS) {
      const next = e.apply(rec, rep);
      if (next) { rep = next; tolerated.push(e.id); }
    }
  }
  return { recorded: rec, replayed: rep, tolerated };
}
