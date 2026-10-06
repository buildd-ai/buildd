#!/usr/bin/env bun
/**
 * Scout probe (state-transition): the follow-up lifecycle of a Quality Scout
 * finding, driven through the candidate checkout's own run + action policy.
 *
 * Invariant: a follow-up task is owed exactly while its finding is open —
 * filed once on a verified failure, refreshed (not re-filed) on recurrence,
 * replaced when its task ended with the finding still failing, and no longer
 * presented as owed once a later run resolves the finding.
 *
 * Run from the root of the checkout under test; it imports THAT tree's code:
 *   (cd <checkout> && bun run <this file>)
 * Prints one line per transition and exits 1 if any is violated.
 */

const root = process.cwd();
const lib = (p: string) => import(`${root}/apps/web/src/lib/${p}`);
const core = (p: string) => import(`${root}/packages/core/${p}`);

const { runQualityScout } = await lib('quality-scout-run.ts');
const { computeReadiness } = await core('workspace-readiness.ts');
const { discoverScoutCapabilities } = await core('scout-capabilities.ts');

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export {};

const profile = discoverScoutCapabilities({
  readiness: computeReadiness({ files: ['pyproject.toml', 'src/app/main.py'], manifests: { 'pyproject.toml': '[project]\nname = "app"\n' } }),
  extension: { journeys: [{ name: 'smoke', kind: 'cli', command: 'app --smoke', mutates: false }] },
});

// ── A local world: findings, tasks, runs ──
const findings = new Map<string, Any>();
const tasks = new Map<string, { status: string; refreshed: number }>();
const runs: Any[] = [];
let n = 0;
const RANK: Record<string, number> = { none: 0, retained: 1, aggregated: 2, proposed: 3, filed: 4 };
const ledger = {
  latestRun: async () => { const r = runs.filter((x) => x.status === 'completed').at(-1); return r ? { id: r.id, sha: r.candidate.sha } : null; },
  claimRun: async (run: Any) => (runs.some((r) => r.id === run.id) ? 'duplicate' : (runs.push(run), 'claimed')),
  saveRun: async (run: Any) => { const i = runs.findIndex((r) => r.id === run.id); runs[i] = run; },
  saveProbes: async () => {},
  findings: {
    find: async (_w: string, s: string) => findings.get(s) ?? null,
    insert: async (f: Any) => (findings.has(f.signature) ? false : (findings.set(f.signature, f), true)),
    update: async (f: Any, c: number) => {
      const cur = findings.get(f.signature);
      if (cur?.occurrenceCount !== c) return false;
      findings.set(f.signature, { ...f, actionState: cur.actionState, actionTaskId: cur.actionTaskId });
      return true;
    },
  },
  resolveForPass: async (run: Any, p: Any) => {
    let k = 0;
    for (const [s, f] of findings) if (f.checkId === p.result.checkId && f.state === 'open') { findings.set(s, { ...f, state: 'resolved', resolvedRunId: run.id }); k++; }
    return k;
  },
};
const actions = {
  raiseActionState: async (_w: string, s: string, to: string) => {
    const f = findings.get(s);
    if (!f || RANK[f.actionState] >= RANK[to]) return false;
    findings.set(s, { ...f, actionState: to });
    return true;
  },
  taskStatus: async (id: string) => tasks.get(id)?.status ?? null,
  insertTask: async () => { const id = `t${++n}`; tasks.set(id, { status: 'pending', refreshed: 0 }); return { id }; },
  claimFollowUp: async (_w: string, s: string, id: string, takeover: string[]) => {
    const f = findings.get(s);
    if (f.actionTaskId && !takeover.includes(f.actionTaskId)) return false;
    findings.set(s, { ...f, actionState: 'filed', actionTaskId: id });
    return true;
  },
  currentTaskId: async (_w: string, s: string) => findings.get(s)?.actionTaskId ?? null,
  deleteTask: async (id: string) => { tasks.delete(id); },
  refreshTask: async (id: string) => { const t = tasks.get(id); if (t) t.refreshed++; return !!t; },
  announce: async () => {},
};

let exit = 2;
async function run(shaChar: string, mode = 'propose') {
  const sha = shaChar.repeat(40);
  const out = await runQualityScout(
    { workspaceId: 'probe', trigger: 'periodic', mode, candidate: { ref: 'main', sha } },
    {
      now: () => new Date(),
      loadProfile: async () => profile,
      gatherSignals: async () => ({ candidateRef: 'main', changedPaths: ['src/app/main.py'] }),
      decide: async () => ({ decision: 'run', reasonCode: 'probe', source: 'rule' }),
      ports: { command: { run: async () => ({ exitCode: exit, timedOut: false, stderrTail: 'smoke failed', evidenceRef: `log:${sha.slice(0, 4)}` }) } },
      ledger,
      actions,
      headSha: async () => sha,
    },
  );
  if (out.status !== 'completed') throw new Error(`run ${shaChar}: ${JSON.stringify(out)}`);
  return out;
}

const results: Array<{ step: string; ok: boolean; detail: string }> = [];
const check = (step: string, ok: boolean, detail: string) => results.push({ step, ok, detail });
const live = () => [...tasks.entries()].filter(([, t]) => !['completed', 'failed', 'cancelled'].includes(t.status));
const only = () => [...findings.values()][0];

await run('a');
check('fail files one follow-up', tasks.size === 1 && only()?.actionState === 'filed', `tasks=${tasks.size} actionState=${only()?.actionState}`);

await run('b');
check('recurrence refreshes, never re-files', tasks.size === 1 && [...tasks.values()][0].refreshed === 1, `tasks=${tasks.size} refreshed=${[...tasks.values()][0]?.refreshed}`);

tasks.get(only().actionTaskId)!.status = 'completed';
await run('c');
check('an ended follow-up with the finding still failing is replaced by exactly one', live().length === 1 && tasks.size === 2, `tasks=${tasks.size} live=${live().length}`);

for (const status of ['in_progress', 'review']) {
  const id = only().actionTaskId;
  tasks.get(id)!.status = status;
  const before = tasks.size;
  await run(status === 'review' ? 'e' : 'd');
  check(`a follow-up in "${status}" is refreshed, not duplicated`, tasks.size === before, `tasks=${tasks.size} (was ${before})`);
  tasks.get(id)!.status = 'pending';
}

exit = 0;
const pass = await run('f');
const f = only();
check('a pass resolves the finding', f.state === 'resolved' && pass.metrics.findings.resolved === 1, `state=${f.state}`);
const owed = live().filter(([id]) => id === f.actionTaskId);
check(
  'a resolved finding leaves no follow-up presented as owed',
  owed.length === 0,
  owed.length ? `follow-up ${owed[0][0]} is still "${owed[0][1].status}" after the finding resolved; actionState=${f.actionState}` : 'none live',
);

for (const r of results) console.log(`${r.ok ? 'HOLDS    ' : 'VIOLATION'} ${r.step} — ${r.detail}`);
const bad = results.filter((r) => !r.ok).length;
console.log(bad ? `${bad} invariant(s) violated` : 'ALL INVARIANTS HOLD');
process.exit(bad ? 1 : 0);
