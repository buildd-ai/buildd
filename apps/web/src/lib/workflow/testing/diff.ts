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

export const KNOWN_EVOLUTIONS: KnownEvolution[] = [
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
