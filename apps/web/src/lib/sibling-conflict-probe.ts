/**
 * Live sibling conflict probe: warn two running workers early when their
 * branches will not merge, instead of letting the second PR find out at merge.
 *
 * Same-file overlap no longer holds a task at claim (HOLD/START decides), and
 * most shared-file pairs merge cleanly. The ones that do not are worth one
 * message while both diffs are still small. So:
 *
 *  1. Find (the cron, `requestSiblingProbes`): pairs of live workers in one
 *     workspace whose observed touches (the runner's touched-paths heartbeat)
 *     share a file. Generated files never count: a derived-file driver
 *     regenerates them. A pair is asked at most once per
 *     `SIBLING_PROBE_INTERVAL_MS`; the request goes to the PROBER, the worker
 *     that would rebase.
 *  2. Probe (the prober's runner, on its next heartbeat): `git merge-tree`
 *     between its HEAD and the sibling's pushed branch; with the workspace's
 *     `gitConfig.mergiraf` on, each conflicted file is retried through
 *     mergiraf, and a structural merge does not count.
 *  3. Notify (`applySiblingProbeResult`, the result's heartbeat): a real
 *     conflict sends both workers one instruction through the instruct queue
 *     (the base-advance-notice channel) naming the files, the conflict regions
 *     and who rebases. Once per pair per `SIBLING_NOTICE_DEBOUNCE_MS`. Every
 *     result is a `sibling_conflict_probe` gate event, the denominator for
 *     "does early warning cut conflict retries".
 *
 * Who rebases: the worker not yet in review (no PR) when exactly one has a PR;
 * otherwise the later starter.
 *
 * Pure: no DB. `sibling-conflict-probe-store.ts` supplies the deps.
 */
import { REPO_WIDE_SENTINEL, findRegenerable, stripTrailingSep } from '@buildd/core/path-overlap';
import { matchesGitattributesPattern } from './hard-overlap-surfaces';
import type { SiblingProbe, SiblingProbeOutcome } from '@buildd/core/db/schema';
import type { SiblingProbeRequest, SiblingProbeResult } from '@buildd/shared';

/**
 * Due-queue (`buildd:due:<name>`, lib/cron-due-queue.ts): the worker PATCH
 * route marks a workspace due when a heartbeat reports new touched paths, so
 * the gated cron tick only reads Postgres when some worker's touches moved.
 */
export const SIBLING_PROBE_DUE_QUEUE = 'sibling-probe';

/** A pair is probed at most this often. */
export const SIBLING_PROBE_INTERVAL_MS = 20 * 60_000;
/** Both workers are told about one pair at most this often. */
export const SIBLING_NOTICE_DEBOUNCE_MS = 60 * 60_000;
/** A request handed to a runner and never answered is re-asked after this. */
export const SIBLING_PROBE_DISPATCH_TIMEOUT_MS = 15 * 60_000;

const MAX_FILES_LISTED = 15;
const MAX_SHARED_FILES = 50;

export interface ProbeWorker {
  workerId: string;
  taskId: string | null;
  workspaceId: string;
  missionId: string | null;
  branch: string;
  title: string | null;
  startedAt: string | null;
  /** Non-null once the worker opened its PR: it is in review. */
  prNumber: number | null;
  observedTouches: string[] | null;
  /** Workspace `gitConfig.mergiraf`. */
  mergiraf: boolean;
  sensitive: boolean;
  /** Workspace `gitConfig.derivedFiles` globs: generated files, never a real conflict. */
  generatedGlobs?: string[];
}

/** Built-in regenerable files and the workspace's derived files. */
export function isGeneratedPath(path: string, globs: readonly string[] | undefined): boolean {
  return !!findRegenerable(path) || (globs ?? []).some(g => matchesGitattributesPattern(path, g));
}

export interface SiblingPair {
  pairKey: string;
  workspaceId: string;
  a: ProbeWorker;
  b: ProbeWorker;
  sharedFiles: string[];
  rebaser: ProbeWorker;
}

export function siblingPairKey(x: string, y: string): string {
  return x < y ? `${x}:${y}` : `${y}:${x}`;
}

function concreteFiles(paths: string[] | null | undefined, globs: readonly string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const raw of paths ?? []) {
    if (typeof raw !== 'string' || !raw || raw === REPO_WIDE_SENTINEL) continue;
    const p = stripTrailingSep(raw);
    if (!p || isGeneratedPath(p, globs)) continue;
    out.add(p);
  }
  return out;
}

/** Who rebases if the two conflict: the one not yet in review, else the later starter. */
export function pickRebaser(a: ProbeWorker, b: ProbeWorker): ProbeWorker {
  const aReview = a.prNumber !== null;
  const bReview = b.prNumber !== null;
  if (aReview !== bReview) return aReview ? b : a;
  const at = a.startedAt ? Date.parse(a.startedAt) : NaN;
  const bt = b.startedAt ? Date.parse(b.startedAt) : NaN;
  if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at > bt ? a : b;
  if (Number.isFinite(at) !== Number.isFinite(bt)) return Number.isFinite(at) ? b : a;
  return a.workerId > b.workerId ? a : b;
}

/** Pairs of live workers in one workspace whose observed touches share a (non-generated) file. */
export function findSiblingPairs(workers: readonly ProbeWorker[]): SiblingPair[] {
  const byWorkspace = new Map<string, Array<{ w: ProbeWorker; files: Set<string> }>>();
  for (const w of workers) {
    if (!w.branch) continue;
    const files = concreteFiles(w.observedTouches, w.generatedGlobs);
    if (files.size === 0) continue;
    const list = byWorkspace.get(w.workspaceId) ?? [];
    list.push({ w, files });
    byWorkspace.set(w.workspaceId, list);
  }
  const pairs: SiblingPair[] = [];
  for (const [workspaceId, list] of byWorkspace) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const x = list[i], y = list[j];
        if (x.w.workerId === y.w.workerId || x.w.branch === y.w.branch) continue;
        if (x.w.taskId && x.w.taskId === y.w.taskId) continue;
        const shared = [...x.files].filter(f => y.files.has(f)).sort();
        if (shared.length === 0) continue;
        const [a, b] = x.w.workerId < y.w.workerId ? [x.w, y.w] : [y.w, x.w];
        pairs.push({
          pairKey: siblingPairKey(a.workerId, b.workerId),
          workspaceId,
          a,
          b,
          sharedFiles: shared.slice(0, MAX_SHARED_FILES),
          rebaser: pickRebaser(a, b),
        });
      }
    }
  }
  return pairs;
}

type ProbeRow = Pick<SiblingProbe, 'id' | 'status' | 'requestedAt' | 'dispatchedAt' | 'probedAt'>;

/** Ask this pair now? Not while a request is outstanding, not inside the probe interval. */
export function shouldRequestProbe(existing: ProbeRow | null | undefined, now: Date): boolean {
  if (!existing) return true;
  const t = now.getTime();
  if (existing.status === 'requested') return false;
  if (existing.status === 'dispatched') {
    const at = existing.dispatchedAt ? new Date(existing.dispatchedAt).getTime() : 0;
    return t - at >= SIBLING_PROBE_DISPATCH_TIMEOUT_MS;
  }
  const last = existing.probedAt ? new Date(existing.probedAt).getTime() : 0;
  return t - last >= SIBLING_PROBE_INTERVAL_MS;
}

export function siblingConflictMarker(pairKey: string): string {
  return `[sibling-conflict: ${pairKey}]`;
}

export function buildSiblingConflictInstruction(args: {
  pairKey: string;
  self: 'rebaser' | 'holder';
  other: { title: string | null; branch: string; inReview: boolean };
  conflicts: SiblingProbeResult['conflicts'];
}): string {
  const conflicts = args.conflicts ?? [];
  const listed = conflicts.slice(0, MAX_FILES_LISTED).map(c => {
    const hunks = c.hunks.slice(0, 5).map(h => (h.startLine === h.endLine ? `line ${h.startLine}` : `lines ${h.startLine}-${h.endLine}`));
    return `- ${c.path}${hunks.length > 0 ? ` (${hunks.join(', ')}${c.hunks.length > 5 ? ', …' : ''})` : ''}`;
  });
  if (conflicts.length > MAX_FILES_LISTED) listed.push(`- …and ${conflicts.length - MAX_FILES_LISTED} more`);
  const who = `\`${args.other.branch}\`${args.other.title ? ` ("${args.other.title}")` : ''}`;
  const look = `See their side with \`git fetch origin ${args.other.branch} && git diff HEAD...FETCH_HEAD -- <file>\`.`;
  const role = args.self === 'rebaser'
    ? `You rebase: ${args.other.inReview ? 'their PR is already in review' : 'you started after them'}. Keep your edits to those regions as small as you can, and when their PR lands bring your base in first (\`git fetch origin && git rebase origin/<base>\`) and resolve on your side.`
    : 'They rebase onto your work, so carry on. Avoid widening your edits in those regions, and do not rewrite them without need.';
  return [
    `**LIVE SIBLING CONFLICT** ${siblingConflictMarker(args.pairKey)}: your branch and ${who}, another live worker, both edit these files, and a trial merge of the two branches conflicts:`,
    ...listed,
    role,
    look,
  ].join('\n');
}

export interface ProbeRowFull extends ProbeRow {
  pairKey: string;
  workspaceId: string;
  workerAId: string;
  workerBId: string;
  proberWorkerId: string;
  sharedFiles: string[];
  notifiedAt: Date | string | null;
}

export interface SiblingProbeDeps {
  loadLiveWorkers(): Promise<ProbeWorker[]>;
  /** Existing rows keyed by pairKey (worker ids are global, so the key is too). */
  loadProbes(pairKeys: string[]): Promise<Map<string, ProbeRowFull>>;
  /** Insert or re-arm the pair's row as `requested` for this prober. */
  upsertRequest(pair: SiblingPair, now: Date): Promise<void>;
  /** Requested rows for this prober, flipped to `dispatched`, with the sibling's branch. */
  takeRequests(workerId: string, now: Date): Promise<Array<ProbeRowFull & { otherBranch: string; mergiraf: boolean }>>;
  /** The row for this probe id, only if `workerId` is its prober. */
  loadProbe(probeId: string, workerId: string): Promise<ProbeRowFull | null>;
  loadWorkers(ids: string[]): Promise<Map<string, ProbeWorker>>;
  saveResult(probeId: string, fields: { outcome: SiblingProbeOutcome; conflictFiles: string[] | null; probedAt: Date; notifiedAt?: Date }): Promise<void>;
  queueInstruction(worker: ProbeWorker, text: string, marker: string): Promise<boolean>;
  recordProbe(event: SiblingProbeEvent): Promise<void>;
  now?(): Date;
}

export interface SiblingProbeEvent {
  outcome: SiblingProbeOutcome;
  pairKey: string;
  prober: ProbeWorker;
  other: ProbeWorker | null;
  rebaserWorkerId: string | null;
  sharedFiles: string[];
  conflictFiles: string[];
  resolvedByMergiraf: string[];
  notified: string[];
  debounced: boolean;
  headSha: string | null;
  otherSha: string | null;
  error: string | null;
}

/** Cron: find the live pairs and ask each one's prober. */
export async function requestSiblingProbes(deps: SiblingProbeDeps): Promise<{ pairs: number; requested: number }> {
  const now = deps.now?.() ?? new Date();
  const pairs = findSiblingPairs(await deps.loadLiveWorkers());
  if (pairs.length === 0) return { pairs: 0, requested: 0 };
  const existing = await deps.loadProbes(pairs.map(p => p.pairKey));
  let requested = 0;
  for (const pair of pairs) {
    try {
      if (!shouldRequestProbe(existing.get(pair.pairKey), now)) continue;
      await deps.upsertRequest(pair, now);
      requested++;
    } catch (err) {
      console.error(`[sibling-probe] request for ${pair.pairKey} failed:`, err);
    }
  }
  return { pairs: pairs.length, requested };
}

/** Heartbeat: the probes this worker's runner should run now. */
export async function takeSiblingProbeRequests(workerId: string, deps: SiblingProbeDeps): Promise<SiblingProbeRequest[]> {
  const rows = await deps.takeRequests(workerId, deps.now?.() ?? new Date());
  return rows.map(r => ({ probeId: r.id, otherBranch: r.otherBranch, sharedFiles: r.sharedFiles, mergiraf: r.mergiraf }));
}

/** Conflicts on generated files are not real: the derived-file driver regenerates them. */
function realConflicts(result: SiblingProbeResult, globs: readonly string[] | undefined): NonNullable<SiblingProbeResult['conflicts']> {
  return (result.conflicts ?? []).filter(c => typeof c?.path === 'string' && !isGeneratedPath(c.path, globs));
}

/**
 * Heartbeat: record what the prober's runner found, and on a real conflict
 * tell both workers once per pair inside the debounce. Never throws.
 */
export async function applySiblingProbeResult(
  workerId: string,
  result: SiblingProbeResult,
  deps: SiblingProbeDeps,
): Promise<{ recorded: boolean; notified: string[] }> {
  try {
    const row = await deps.loadProbe(result.probeId, workerId);
    if (!row) return { recorded: false, notified: [] };
    const now = deps.now?.() ?? new Date();
    const otherId = row.workerAId === workerId ? row.workerBId : row.workerAId;
    const workersById = await deps.loadWorkers([workerId, otherId]);
    const prober = workersById.get(workerId);
    const other = workersById.get(otherId) ?? null;
    if (!prober) return { recorded: false, notified: [] };

    const conflicts = result.outcome === 'conflict' ? realConflicts(result, prober.generatedGlobs) : [];
    const outcome: SiblingProbeOutcome = result.outcome === 'conflict' && conflicts.length === 0
      ? ((result.resolvedByMergiraf?.length ?? 0) > 0 ? 'mergiraf_resolved' : 'clean')
      : result.outcome;
    const conflictFiles = conflicts.map(c => c.path);

    const notified: string[] = [];
    let debounced = false;
    let notifiedAt: Date | undefined;
    if (outcome === 'conflict' && other) {
      const last = row.notifiedAt ? new Date(row.notifiedAt).getTime() : 0;
      if (now.getTime() - last < SIBLING_NOTICE_DEBOUNCE_MS) {
        debounced = true;
      } else {
        const rebaser = pickRebaser(prober, other);
        const marker = siblingConflictMarker(row.pairKey);
        for (const [self, them] of [[prober, other], [other, prober]] as const) {
          const text = buildSiblingConflictInstruction({
            pairKey: row.pairKey,
            self: self.workerId === rebaser.workerId ? 'rebaser' : 'holder',
            other: { title: them.title, branch: them.branch, inReview: them.prNumber !== null },
            conflicts,
          });
          try {
            if (await deps.queueInstruction(self, text, marker)) notified.push(self.workerId);
          } catch (err) {
            console.error(`[sibling-probe] notice to ${self.workerId} failed:`, err);
          }
        }
        if (notified.length > 0) notifiedAt = now;
      }
    }

    await deps.saveResult(row.id, { outcome, conflictFiles: conflictFiles.length > 0 ? conflictFiles : null, probedAt: now, ...(notifiedAt ? { notifiedAt } : {}) });
    await deps.recordProbe({
      outcome,
      pairKey: row.pairKey,
      prober,
      other,
      rebaserWorkerId: other ? pickRebaser(prober, other).workerId : null,
      sharedFiles: row.sharedFiles,
      conflictFiles,
      resolvedByMergiraf: (result.resolvedByMergiraf ?? []).filter(p => typeof p === 'string').slice(0, 50),
      notified,
      debounced,
      headSha: result.headSha ?? null,
      otherSha: result.otherSha ?? null,
      error: outcome === 'error' ? String(result.error ?? 'unknown').slice(0, 300) : null,
    });
    return { recorded: true, notified };
  } catch (err) {
    console.error(`[sibling-probe] result ${result?.probeId} from ${workerId} failed:`, err);
    return { recorded: false, notified: [] };
  }
}

/** Shape check for a result arriving on the PATCH body. */
export function readSiblingProbeResults(raw: unknown): SiblingProbeResult[] {
  if (!Array.isArray(raw)) return [];
  const out: SiblingProbeResult[] = [];
  for (const r of raw.slice(0, 10)) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.probeId !== 'string') continue;
    if (o.outcome !== 'clean' && o.outcome !== 'conflict' && o.outcome !== 'mergiraf_resolved' && o.outcome !== 'error') continue;
    const conflicts = Array.isArray(o.conflicts)
      ? o.conflicts.slice(0, 100).flatMap((c): NonNullable<SiblingProbeResult['conflicts']> => {
          const cc = c as { path?: unknown; hunks?: unknown };
          if (typeof cc?.path !== 'string') return [];
          const hunks = Array.isArray(cc.hunks)
            ? cc.hunks.slice(0, 20).flatMap(h => {
                const hh = h as { startLine?: unknown; endLine?: unknown };
                return typeof hh?.startLine === 'number' && typeof hh?.endLine === 'number' ? [{ startLine: hh.startLine, endLine: hh.endLine }] : [];
              })
            : [];
          return [{ path: cc.path, hunks }];
        })
      : undefined;
    out.push({
      probeId: o.probeId,
      outcome: o.outcome,
      ...(conflicts ? { conflicts } : {}),
      ...(Array.isArray(o.resolvedByMergiraf) ? { resolvedByMergiraf: o.resolvedByMergiraf.filter((p): p is string => typeof p === 'string') } : {}),
      ...(typeof o.error === 'string' ? { error: o.error } : {}),
      ...(typeof o.headSha === 'string' ? { headSha: o.headSha } : {}),
      ...(typeof o.otherSha === 'string' ? { otherSha: o.otherSha } : {}),
    });
  }
  return out;
}
