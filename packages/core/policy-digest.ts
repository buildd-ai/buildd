/**
 * Genuine policy decisions fold into one digest line per kind, on Home and in
 * the owner's pushes. Pure: the escalation gate already decided who owns each
 * subject (escalation-gate.ts); this only groups the ones that are a person's
 * *because of a policy rail* and never decides ownership itself.
 *
 * A digest is a view. Every member stays individually reachable and keeps its
 * own approval; nothing here approves, merges or hides a subject.
 */
import type { EscalationRail } from './escalation-gate';

/** The rails that are a policy's call, not a judgment: these batch. */
export const POLICY_RAILS = ['protected_path', 'data_migration', 'security', 'mission_ship_escalation', 'irreversible'] as const satisfies readonly EscalationRail[];
export type PolicyRail = (typeof POLICY_RAILS)[number];

const isPolicyRail = (r: string | null | undefined): r is PolicyRail => !!r && (POLICY_RAILS as readonly string[]).includes(r);

export interface PolicyDecisionCandidate {
  /** Stable subject key (`pr:<workspace>:<number>`). */
  key: string;
  /** The tenant. A subject without one is never folded with another. */
  teamId?: string | null;
  owner: 'person' | 'buildd';
  rail?: string | null;
  machineActing?: boolean;
  prLifecycleStatus?: string | null;
  /** False when the PR moved since the verdict (stale). */
  headIsCurrent?: boolean | null;
}

export interface PolicyDigest<T extends PolicyDecisionCandidate> {
  kind: PolicyRail;
  teamId: string;
  count: number;
  members: T[];
}

function isLiveDecision(c: PolicyDecisionCandidate): boolean {
  if (c.owner !== 'person' || !isPolicyRail(c.rail)) return false;
  if (c.machineActing) return false;
  if (c.prLifecycleStatus === 'merged' || c.prLifecycleStatus === 'closed') return false;
  if (c.headIsCurrent === false) return false;
  return true;
}

/**
 * One digest per (tenant, kind) with two or more live decisions. Everything
 * else (a lone decision, other kinds, machine-owned, resolved or stale
 * subjects) comes back in `rest`, in input order, untouched.
 */
export function digestPolicyDecisions<T extends PolicyDecisionCandidate>(items: readonly T[]): { digests: PolicyDigest<T>[]; rest: T[] } {
  const seen = new Set<string>();
  const groups = new Map<string, T[]>();
  const ordered: Array<{ item: T; group: string | null }> = [];
  for (const item of items) {
    if (isLiveDecision(item)) {
      if (seen.has(item.key)) continue;
      seen.add(item.key);
    }
    const group = isLiveDecision(item) && item.teamId ? `${item.teamId}\u0000${item.rail}` : null;
    if (group) groups.set(group, [...(groups.get(group) ?? []), item]);
    ordered.push({ item, group });
  }
  const digests: PolicyDigest<T>[] = [];
  const rest: T[] = [];
  const emitted = new Set<string>();
  for (const { item, group } of ordered) {
    const members = group ? groups.get(group)! : null;
    if (!group || !members || members.length < 2) { rest.push(item); continue; }
    if (emitted.has(group)) continue;
    emitted.add(group);
    digests.push({ kind: item.rail as PolicyRail, teamId: item.teamId!, count: members.length, members });
  }
  return { digests, rest };
}

const LINES: Record<PolicyRail, (n: number) => string> = {
  protected_path: n => `${n} changes to protected files need your OK`,
  data_migration: n => `${n} data migrations need your OK`,
  security: n => `${n} security concerns need your decision`,
  mission_ship_escalation: n => `${n} mission ships were escalated for your decision`,
  irreversible: n => `${n} irreversible steps need your OK`,
};

/** The one line a digest shows. */
export function policyDigestLine(kind: PolicyRail, count: number): string {
  return LINES[kind](count);
}

export interface PolicyPageEvent {
  teamId: string;
  subjectKey: string;
  kind: PolicyRail;
  /** Changes when the subject's state does (a new push, a new reason). */
  fingerprint: string;
}

export type PolicyPagePlan = { action: 'send' } | { action: 'digest'; count: number } | { action: 'skip' };

/**
 * Decides how a policy escalation reaches the owner: the first of a kind is a
 * page of its own, the second distinct subject becomes one digest page, every
 * further one inside the window is quiet (Home carries the digest line), and a
 * repeat of an unchanged state is never sent twice. Windows are per tenant and
 * kind. In-process memory: best-effort across serverless instances, and it
 * only ever errs toward paging.
 */
export function createPolicyPageLedger(opts: { windowMs?: number; now?: () => number } = {}) {
  const windowMs = opts.windowMs ?? 30 * 60_000;
  const now = opts.now ?? Date.now;
  const windows = new Map<string, { startedAt: number; subjects: Map<string, string>; digested: boolean }>();
  return {
    plan(e: PolicyPageEvent): PolicyPagePlan {
      const t = now();
      const k = `${e.teamId}\u0000${e.kind}`;
      let w = windows.get(k);
      if (!w || t - w.startedAt >= windowMs) {
        w = { startedAt: t, subjects: new Map(), digested: false };
        windows.set(k, w);
      }
      const prior = w.subjects.get(e.subjectKey);
      if (prior === e.fingerprint) return { action: 'skip' };
      w.subjects.set(e.subjectKey, e.fingerprint);
      // A changed state of a subject already paged for is its own page.
      if (prior !== undefined) return { action: 'send' };
      if (w.subjects.size === 1) return { action: 'send' };
      if (!w.digested) { w.digested = true; return { action: 'digest', count: w.subjects.size }; }
      return { action: 'skip' };
    },
  };
}
