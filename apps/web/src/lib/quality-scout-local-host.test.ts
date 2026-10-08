/**
 * The Scout pipeline end to end on a generic, non-Buildd workspace: a real git
 * repo of a small Python CLI with no UI, real commands, the real candidate
 * generator, selector, executors, ledger and action policy. Only the stores are
 * local. Proves the acceptance invariants of the Quality Scout mission:
 *
 *  - capability discovery sees no UI, and nothing surface-shaped is attempted;
 *  - one broken command is one finding and at most one follow-up, however many
 *    hypotheses led to it and however many runs see it again;
 *  - shadow mode makes no product write and leaves the checkout untouched;
 *  - a pass of the same check resolves the finding.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateScoutCandidates } from '@buildd/core/quality-scout/candidates';
import {
  exec,
  gitChangedPaths,
  gitHead,
  gitScoutProfile,
  gitStatus,
  localCommandPort,
  localScoutStore,
  ruleScoutProbeDecider,
} from './quality-scout-local-host';
import { runQualityScout, type ScoutRunDeps, type ScoutRunRequest } from './quality-scout-run';

const EXTENSION = { verificationCommand: 'sh scripts/check.sh' };

let dir: string;
let evidence: string;
const commits: Record<string, string> = {};

async function sh(cmd: string) {
  const r = await exec('bash', ['-c', cmd], { cwd: dir });
  if (r.code !== 0) throw new Error(`${cmd}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(path: string, body: string) {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), body);
}

async function commit(name: string, files: Record<string, string>) {
  for (const [p, b] of Object.entries(files)) write(p, b);
  await sh(`git add -A && git commit -qm ${name}`);
  commits[name] = await gitHead(dir);
}

const CHECK_OK = 'python3 -c "print(\'ok\')"\n';
const CHECK_BROKEN = 'echo "report renderer: KeyError total" >&2\nexit 3\n';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scout-fixture-'));
  evidence = mkdtempSync(join(tmpdir(), 'scout-evidence-'));
  await sh('git init -q -b main && git config user.email fixture@example.invalid && git config user.name fixture && git config commit.gpgsign false');
  await commit('c0', {
    'pyproject.toml': '[project]\nname = "tool"\nversion = "0.1.0"\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
    'src/tool/cli.py': 'def main():\n    print("Usage: tool")\n',
    'src/report/render.py': 'def render(d):\n    return d.get("total", 0)\n',
    'tests/test_cli.py': 'def test_ok():\n    assert True\n',
    'scripts/check.sh': CHECK_OK,
  });
  // Two areas change and the verification breaks.
  await commit('c1', {
    'src/tool/cli.py': 'def main():\n    print("Usage: tool [--json]")\n',
    'src/report/render.py': 'def render(d):\n    return d["total"]\n',
    'scripts/check.sh': CHECK_BROKEN,
  });
  // A different area changes; the same failure is still there.
  await commit('c2', { 'src/export/csv.py': 'def to_csv(rows):\n    return ""\n' });
  // Fixed.
  await commit('c3', { 'scripts/check.sh': CHECK_OK, 'src/report/render.py': 'def render(d):\n    return d.get("total", 0)\n' });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(evidence, { recursive: true, force: true });
});

function harness(store: ReturnType<typeof localScoutStore>) {
  const command = localCommandPort({ dir, evidenceDir: evidence });
  return {
    command,
    async run(name: string, mode: ScoutRunRequest['mode']) {
      const sha = commits[name];
      await sh(`git checkout -q ${sha}`);
      const deps: ScoutRunDeps = {
        now: () => new Date(),
        loadProfile: () => gitScoutProfile(dir, sha, EXTENSION),
        gatherSignals: async ({ candidate, prior }) => ({
          candidateRef: candidate.ref,
          priorRef: prior?.sha ?? null,
          changedPaths: await gitChangedPaths(dir, prior?.sha ?? `${sha}~1`, sha),
        }),
        decide: ruleScoutProbeDecider,
        ports: { command: command.port },
        ledger: store.ledger,
        actions: store.actions,
        headSha: async () => sha,
      };
      const out = await runQualityScout({ workspaceId: 'fixture', trigger: 'periodic', mode, candidate: { ref: 'main', sha } }, deps);
      if (out.status !== 'completed') throw new Error(`run ${name}: ${JSON.stringify(out)}`);
      return out;
    },
  };
}

describe('Quality Scout on a generic no-UI workspace', () => {
  it('discovers no UI and generates no surface candidate', async () => {
    const profile = await gitScoutProfile(dir, commits.c1, EXTENSION);
    expect(profile.hasUi).toBe('no');
    expect(profile.capabilities.find((c) => c.kind === 'verification-command')).toMatchObject({ usable: true, value: 'sh scripts/check.sh' });
    const set = generateScoutCandidates(
      { candidateRef: 'main', changedPaths: await gitChangedPaths(dir, commits.c0, commits.c1) },
      profile,
    );
    expect(set.candidates.length).toBeGreaterThan(1);
    expect(set.candidates.some((c) => c.family === 'surface')).toBe(false);
  });

  it('one broken command is one finding and one follow-up across hypotheses and runs; a pass resolves it', async () => {
    const store = localScoutStore();
    const h = harness(store);

    const first = await h.run('c1', 'propose');
    // Several hypotheses ran the same command against the same tree.
    expect(first.metrics.verdicts.fail).toBeGreaterThanOrEqual(1);
    expect(store.state.findings).toHaveLength(1);
    expect(store.state.tasks).toHaveLength(1);
    expect(store.state.findings[0]).toMatchObject({ state: 'open', actionState: 'filed', reproducibility: 'deterministic' });

    const second = await h.run('c2', 'propose');
    expect(second.metrics.prior?.sha).toBe(commits.c1);
    expect(store.state.findings).toHaveLength(1);
    expect(store.state.tasks).toHaveLength(1);
    expect(store.state.findings[0].occurrenceCount).toBe(2);
    expect(second.metrics.actions.filed).toBe(0);
    expect(second.metrics.dedupeSuppressed).toBeGreaterThanOrEqual(1);

    const third = await h.run('c3', 'propose');
    expect(third.metrics.verdicts.pass).toBeGreaterThanOrEqual(1);
    expect(third.metrics.findings.resolved).toBe(1);
    expect(store.state.findings[0].state).toBe('resolved');
    expect(store.state.tasks).toHaveLength(1);
  });

  it('shadow records the finding but makes no product write and leaves the checkout as it was', async () => {
    const store = localScoutStore();
    const h = harness(store);
    for (const c of ['c1', 'c2']) {
      await h.run(c, 'shadow');
      expect(await gitHead(dir)).toBe(commits[c]);
      expect((await gitStatus(dir)).trim()).toBe('');
    }
    expect(store.state.findings).toHaveLength(1);
    expect(store.state.findings[0]).toMatchObject({ actionState: 'proposed', actionTaskId: null, occurrenceCount: 2 });
    expect(store.state.tasks).toHaveLength(0);
    expect(store.productWrites()).toEqual([]);
    expect(h.command.records.every((r) => r.treeChanges.length === 0)).toBe(true);
  });

  it('an automatic trigger on an already-exercised SHA is a duplicate, not a second run', async () => {
    const store = localScoutStore();
    const h = harness(store);
    await h.run('c1', 'shadow');
    const runs = h.command.records.length;
    await expect(h.run('c1', 'shadow')).rejects.toThrow(/duplicate/);
    expect(h.command.records.length).toBe(runs);
  });

  it('the command port refuses a checkout that is not the candidate', async () => {
    const { port, records } = localCommandPort({ dir, evidenceDir: evidence });
    await sh(`git checkout -q ${commits.c0}`);
    const out = await port.run({ command: 'true', timeoutMs: 5_000, ref: 'main', sha: commits.c1 });
    expect(out.exitCode).toBeNull();
    expect(out.stderrTail).toContain('refused');
    expect(records[0].treeChanges).toEqual([]);
  });
});
