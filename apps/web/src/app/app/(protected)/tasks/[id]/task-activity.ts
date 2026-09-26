/**
 * Pure derivations for the task page's live worker view: the "Now" strip, the
 * tool-call tape and the "Touched" file list, all computed from
 * `workers.milestones`.
 *
 * Runners that record structured tool data put `{tool, path, add, rem, cmd,
 * count}` on action milestones. Older runners only wrote a label ("Edited
 * foo.ts", "Ran: bun test"), so every reader here degrades to parsing that
 * label, and line counts it cannot know stay `null` rather than a fake zero.
 */
import type { WorkerMilestone } from '@buildd/core/db/schema';

export type Milestone = WorkerMilestone;
export type ActivityKind = 'new' | 'edit' | 'read' | 'run';

export interface ClassifiedAction {
  kind: ActivityKind;
  path?: string;
  cmd?: string;
  /** Lines added/removed; `null` when the runner did not record them. */
  add: number | null;
  rem: number | null;
  /** Tool calls this entry stands for (the runner folds repeated reads). */
  count: number;
}

const LEGACY_LABELS: Array<[RegExp, ActivityKind]> = [
  [/^Edited\s+(.+)$/, 'edit'],
  [/^Wrote\s+(.+)$/, 'new'],
  [/^Read\s+(.+)$/, 'read'],
  [/^Ran:\s*(.+)$/, 'run'],
];

export function classifyAction(m: { type: string; label?: string | null; [k: string]: unknown }): ClassifiedAction | null {
  if (m.type !== 'action') return null;
  const a = m as Extract<Milestone, { type: 'action' }>;
  const count = typeof a.count === 'number' && a.count > 0 ? a.count : 1;
  if (a.tool) {
    const add = typeof a.add === 'number' ? a.add : 0;
    const rem = typeof a.rem === 'number' ? a.rem : 0;
    if (a.tool === 'Bash') return { kind: 'run', cmd: a.cmd ?? a.label?.replace(/^Ran:\s*/, '') ?? '', add, rem, count };
    if (a.tool === 'Read') return { kind: 'read', path: a.path, add, rem, count };
    return { kind: a.tool === 'Write' ? 'new' : 'edit', path: a.path, add, rem, count };
  }
  const label = a.label?.trim();
  if (!label) return null;
  for (const [re, kind] of LEGACY_LABELS) {
    const hit = re.exec(label);
    if (!hit) continue;
    return kind === 'run'
      ? { kind, cmd: hit[1], add: null, rem: null, count }
      : { kind, path: hit[1], add: null, rem: null, count };
  }
  return null;
}

export interface TouchedRow {
  kind: ActivityKind;
  path?: string;
  cmd?: string;
  add: number | null;
  rem: number | null;
  lastTs: number;
  count: number;
}

const sumNullable = (a: number | null, b: number | null) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));

/**
 * Files written/edited and commands run, one row per path (or command), newest
 * first. Reads come back separately so the view can fold them away.
 */
export function touchedFiles(milestones: Milestone[]): { rows: TouchedRow[]; reads: TouchedRow[] } {
  const byKey = new Map<string, TouchedRow>();
  const sorted = [...milestones].sort((a, b) => a.ts - b.ts);
  for (const m of sorted) {
    const c = classifyAction(m);
    if (!c) continue;
    const key = c.kind === 'run' ? `run:${c.cmd}` : c.kind === 'read' ? `read:${c.path}` : `file:${c.path}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { kind: c.kind, ...(c.path !== undefined ? { path: c.path } : {}), ...(c.cmd !== undefined ? { cmd: c.cmd } : {}), add: c.add, rem: c.rem, lastTs: m.ts, count: c.count });
      continue;
    }
    // A file first Written this session keeps its "new" glyph through later edits.
    prev.add = c.kind === 'read' || c.kind === 'run' ? prev.add : sumNullable(prev.add, c.add);
    prev.rem = c.kind === 'read' || c.kind === 'run' ? prev.rem : sumNullable(prev.rem, c.rem);
    prev.lastTs = m.ts;
    prev.count += c.count;
  }
  const all = [...byKey.values()].sort((a, b) => b.lastTs - a.lastTs);
  return { rows: all.filter(r => r.kind !== 'read'), reads: all.filter(r => r.kind === 'read') };
}

/** Best estimate of tool calls: phases count them; action entries are a sample. */
export function countToolCalls(milestones: Milestone[]): number {
  let phase = 0;
  let actions = 0;
  for (const m of milestones) {
    if (m.type === 'phase') phase += m.toolCount || 0;
    else if (m.type === 'action') actions += classifyAction(m)?.count ?? 1;
  }
  return Math.max(phase, actions);
}

export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export interface Tape {
  ticks: Array<{ pos: number; kind: 'edit' | 'read' | 'run'; label: string }>;
  flags: Array<{ pos: number; pct: number; label: string; at: string }>;
  axis: string[];
}

export function buildTape(milestones: Milestone[], { startMs, nowMs }: { startMs: number; nowMs: number }): Tape {
  const span = Math.max(1, nowMs - startMs);
  const pos = (ts: number) => Math.round(Math.min(1, Math.max(0, (ts - startMs) / span)) * 1000) / 1000;
  const sorted = [...milestones].sort((a, b) => a.ts - b.ts);
  const ticks: Tape['ticks'] = [];
  const flags: Tape['flags'] = [];
  for (const m of sorted) {
    if (m.type === 'action') {
      const c = classifyAction(m);
      ticks.push({ pos: pos(m.ts), kind: c?.kind === 'run' ? 'run' : c?.kind === 'read' ? 'read' : 'edit', label: m.label ?? 'Action' });
    } else if (m.type === 'status' && typeof m.progress === 'number' && m.progress < 100) {
      flags.push({ pos: pos(m.ts), pct: m.progress, label: m.label ?? '', at: formatOffset(m.ts - startMs) });
    }
  }
  const axis = [0, 0.25, 0.5, 0.75].map(f => formatOffset(span * f));
  return { ticks, flags, axis };
}

export type StepKey = 'started' | 'read' | 'edit' | 'commit' | 'pr' | 'done';
export interface NowStep { key: StepKey; label: string; state: 'done' | 'current' | 'todo'; at: string | null }
export interface NowState {
  headline: string | null;
  pct: number | null;
  detail: { verb: string; target: string; recentEdits: number } | null;
  updatedTs: number | null;
  steps: NowStep[];
}

const STEP_LABELS: Record<StepKey, string> = {
  started: 'Started', read: 'Read', edit: 'Edit', commit: 'Commit', pr: 'PR', done: 'Done',
};

// Status milestones that record bookkeeping around a question rather than work.
const NOT_A_HEADLINE = /^(Asked:|Question:|Answer received:|User:)/;

const VERBS: Record<ActivityKind, string> = { new: 'Writing', edit: 'Editing', read: 'Reading', run: 'Running' };

export function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  return trimmed.split('/').pop() || trimmed;
}

export function deriveNow(
  milestones: Milestone[],
  opts: { status: string; currentAction: string | null; prUrl: string | null; startMs: number | null; nowMs: number },
): NowState {
  const sorted = [...milestones].sort((a, b) => a.ts - b.ts);
  const startMs = opts.startMs ?? sorted[0]?.ts ?? opts.nowMs;

  let headline: string | null = null;
  let pct: number | null = null;
  const firstAt: Partial<Record<StepKey, number>> = {};
  const createdPaths = new Set<string>();
  let lastAction: { c: ClassifiedAction; ts: number } | null = null;
  let recentEdits = 0;

  for (const m of sorted) {
    if (m.type === 'checkpoint') {
      const key = ({ session_started: 'started', first_read: 'read', first_edit: 'edit', first_commit: 'commit', task_completed: 'done' } as Record<string, StepKey>)[m.event];
      if (key && firstAt[key] == null) firstAt[key] = m.ts;
    } else if (m.type === 'status') {
      const label = m.label?.trim();
      if (label && /^Commit:/.test(label) && firstAt.commit == null) firstAt.commit = m.ts;
      if (label && /^Opened PR\b/.test(label) && firstAt.pr == null) firstAt.pr = m.ts;
      if (typeof m.progress === 'number') pct = m.progress;
      if (label && !NOT_A_HEADLINE.test(label)) headline = label;
    } else if (m.type === 'action') {
      const c = classifyAction(m);
      if (!c) continue;
      if (c.kind === 'new' && c.path) createdPaths.add(c.path);
      lastAction = { c, ts: m.ts };
      if ((c.kind === 'edit' || c.kind === 'new') && m.ts >= opts.nowMs - 60_000) recentEdits += 1;
    }
  }
  if (firstAt.started == null && sorted.length > 0) firstAt.started = startMs;
  if (opts.prUrl && firstAt.pr == null) firstAt.pr = firstAt.commit ?? startMs;
  if (firstAt.pr != null && firstAt.commit == null) firstAt.commit = firstAt.pr;

  let detail: NowState['detail'] = null;
  if (lastAction) {
    const { c } = lastAction;
    const kind: ActivityKind = c.path && createdPaths.has(c.path) ? 'new' : c.kind;
    const target = c.kind === 'run' ? (c.cmd ?? '') : basename(c.path ?? '');
    if (target) detail = { verb: VERBS[kind], target, recentEdits };
  }

  const order: StepKey[] = ['started', 'read', 'edit', 'commit', 'pr', 'done'];
  let currentAssigned = false;
  const steps: NowStep[] = order.map(key => {
    const ts = firstAt[key];
    if (ts != null) return { key, label: STEP_LABELS[key], state: 'done', at: formatOffset(ts - startMs) };
    if (!currentAssigned) {
      currentAssigned = true;
      return { key, label: STEP_LABELS[key], state: 'current', at: null };
    }
    return { key, label: STEP_LABELS[key], state: 'todo', at: null };
  });

  const updatedTs = sorted.length ? sorted[sorted.length - 1].ts : null;
  return { headline: headline ?? opts.currentAction ?? null, pct, detail, updatedTs, steps };
}

/**
 * Proportional segments for a diff bar split by attempt: each attempt's added
 * then removed lines, as a fraction of the whole change.
 */
export function diffSegments(attempts: Array<{ add: number; rem: number }>): Array<{ attempt: number; kind: 'add' | 'rem'; frac: number }> {
  const total = attempts.reduce((s, a) => s + Math.max(0, a.add) + Math.max(0, a.rem), 0);
  if (total <= 0) return [];
  const round = (n: number) => Math.round(n * 10_000) / 10_000;
  return attempts.flatMap((a, attempt) => [
    ...(a.add > 0 ? [{ attempt, kind: 'add' as const, frac: round(a.add / total) }] : []),
    ...(a.rem > 0 ? [{ attempt, kind: 'rem' as const, frac: round(a.rem / total) }] : []),
  ]);
}
