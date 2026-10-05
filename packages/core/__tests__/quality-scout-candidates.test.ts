import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { computeReadiness, type ReadinessInput } from '../workspace-readiness';
import { discoverScoutCapabilities, type ScoutCapabilityProfile } from '../scout-capabilities';
import {
  generateScoutCandidates,
  matchesPathPattern,
  DEFAULT_MAX_CANDIDATES,
  type ScoutProbeCandidate,
  type ScoutSignals,
} from '../quality-scout/candidates';

// ─── Fixture workspaces (no buildd paths, no web framework assumed) ──────────

/** A Go HTTP service with no browser UI, plus a declared read-only API journey. */
const goService: ReadinessInput = {
  files: ['go.mod', 'go.sum', 'main.go', 'Makefile', 'README.md', 'internal/billing/invoice.go', 'migrations/0001_init.sql'],
  manifests: { 'go.mod': 'module example.com/svc\n', Makefile: 'test:\n\tgo test ./...\nrun:\n\tgo run .\n' },
};
const goProfile: ScoutCapabilityProfile = discoverScoutCapabilities({
  readiness: computeReadiness(goService),
  extension: {
    testEnvironment: { baseUrl: 'https://qa.example.test', ephemeral: false },
    journeys: [{ name: 'invoices', kind: 'api', method: 'GET', path: '/invoices' }],
  },
});

/** A Python CLI: verification command only, nothing else. */
const pythonCli: ReadinessInput = {
  files: ['pyproject.toml', 'uv.lock', 'src/tool/cli.py', 'tests/test_cli.py'],
  manifests: { 'pyproject.toml': '[project]\nname = "tool"\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n' },
};
const cliProfile = discoverScoutCapabilities({ readiness: computeReadiness(pythonCli) });

const base = (over: Partial<ScoutSignals> = {}): ScoutSignals => ({
  candidateRef: 'abc1234',
  priorRef: 'fff0000',
  changedPaths: [],
  ...over,
});

const byFamily = (cs: readonly ScoutProbeCandidate[], family: string) => cs.filter((c) => c.family === family);
const bySignal = (cs: readonly ScoutProbeCandidate[], type: string) => cs.filter((c) => c.sourceSignals.some((s) => s.type === type));

describe('generateScoutCandidates — grounding', () => {
  it('produces nothing from nothing: no signals, no folklore candidates', () => {
    const { candidates } = generateScoutCandidates(base(), goProfile);
    expect(candidates).toEqual([]);
  });

  it('turns changed paths into change-grounded candidates, one per changed area', () => {
    const { candidates } = generateScoutCandidates(
      base({ changedPaths: ['internal/billing/invoice.go', 'internal/billing/tax.go', 'cmd/svc/main.go'] }),
      goProfile,
    );
    const change = bySignal(candidates, 'change');
    expect(change.map((c) => c.anchor).sort()).toEqual(['cmd/svc', 'internal/billing']);
    for (const c of change) {
      expect(c.grounding).toBe('change');
      expect(c.touchesChangedPaths).toBe(true);
    }
  });

  it('a migration-shaped change becomes a persistence probe that needs the migrations capability', () => {
    const { candidates } = generateScoutCandidates(base({ changedPaths: ['migrations/0002_add_tax.sql'] }), goProfile);
    const [p] = byFamily(candidates, 'persistence');
    expect(p).toBeDefined();
    expect(p.preconditions).toContain('migrations');
    expect(p.invariant).toMatch(/migration/i);
  });

  it('a UI-shaped change becomes a surface probe only when the workspace has UI; otherwise it is not invented', () => {
    const { candidates } = generateScoutCandidates(base({ changedPaths: ['web/components/Button.vue'] }), cliProfile);
    expect(byFamily(candidates, 'surface')).toEqual([]);
    expect(candidates.length).toBeGreaterThan(0);
  });

  it('history is a hypothesis, never proof: recall and failure candidates are marked history and phrased as "does not"', () => {
    const { candidates } = generateScoutCandidates(
      base({
        changedPaths: ['internal/billing/invoice.go'],
        failures: [{ signature: 'nil-deref-invoice-total', count: 4, paths: ['internal/billing/invoice.go'] }],
        recall: [{ ref: 'm:1a2b3c4d', type: 'gotcha', title: 'Rounding drifts when tax is applied twice', paths: ['internal/billing/'] }],
      }),
      goProfile,
    );
    const hist = candidates.filter((c) => c.grounding === 'history');
    expect(hist.length).toBe(2);
    for (const c of hist) expect(c.invariant).toMatch(/does not|no longer/i);
    const failure = bySignal(candidates, 'failure')[0];
    expect(failure.priorFailures).toBe(4);
  });

  it('recall that does not touch anything that changed is not relevant and yields no candidate', () => {
    const { candidates } = generateScoutCandidates(
      base({
        changedPaths: ['internal/billing/invoice.go'],
        recall: [{ ref: 'm:9', type: 'gotcha', title: 'Unrelated', paths: ['docs/'] }, { ref: 'm:10', type: 'gotcha', title: 'No paths' }],
      }),
      goProfile,
    );
    expect(bySignal(candidates, 'recall')).toEqual([]);
  });

  it('reviewer request-changes and escalations become state-transition hypotheses; an approval does not', () => {
    const { candidates } = generateScoutCandidates(
      base({
        recentWork: [
          { ref: 'pr:12', title: 'Retry after interruption', reviewState: 'changes_requested', paths: ['internal/jobs/retry.go'] },
          { ref: 'pr:13', title: 'Approval staleness', reviewState: 'escalated' },
          { ref: 'pr:14', title: 'Fine', reviewState: 'approved' },
        ],
      }),
      goProfile,
    );
    const st = byFamily(candidates, 'state-transition');
    expect(st.map((c) => c.sourceSignals[0].ref).sort()).toEqual(['pr:12', 'pr:13']);
    expect(st.find((c) => c.sourceSignals[0].ref === 'pr:13')?.severity).toBe('high');
  });

  it('spec discrepancies, visual findings and readiness regressions each yield a grounded candidate', () => {
    const { candidates } = generateScoutCandidates(
      base({
        specDiscrepancies: [
          { ref: 'disc:1', direction: 'contradicted', summary: 'Invoices endpoint returns totals in cents' },
          { ref: 'disc:2', direction: 'code_ahead', summary: 'Shipped but undocumented' },
        ],
        visualFindings: [{ ref: 'shot:1', route: '/invoices', severity: 'medium', summary: 'Empty state overlaps header' }],
        readinessChanges: [
          { itemId: 'test-command', from: 'detected', to: 'missing' },
          { itemId: 'spec-root', from: 'missing', to: 'missing' },
        ],
      }),
      goProfile,
    );
    expect(bySignal(candidates, 'spec').map((c) => c.sourceSignals[0].ref)).toEqual(['disc:1']);
    expect(bySignal(candidates, 'visual')).toHaveLength(1);
    const release = bySignal(candidates, 'readiness');
    expect(release).toHaveLength(1);
    expect(release[0].severity).toBe('high');
  });

  it('a configured critical path is a candidate only when the change touches it, and keeps the owner\'s invariant', () => {
    const critical = [
      { name: 'billing', pattern: 'internal/billing/**', severity: 'critical' as const, invariant: 'An invoice total always equals the sum of its lines.' },
      { name: 'auth', pattern: 'internal/auth/**', severity: 'critical' as const },
    ];
    const { candidates } = generateScoutCandidates(base({ changedPaths: ['internal/billing/invoice.go'], criticalPaths: critical }), goProfile);
    const cp = bySignal(candidates, 'critical-path');
    expect(cp).toHaveLength(1);
    expect(cp[0].invariant).toBe('An invoice total always equals the sum of its lines.');
    expect(cp[0].grounding).toBe('config');
    expect(cp[0].severity).toBe('critical');
  });

  it('a prior severe finding on a changed path is re-checked with its original invariant', () => {
    const { candidates } = generateScoutCandidates(
      base({
        changedPaths: ['internal/billing/invoice.go'],
        priorFindings: [
          { signature: 'sig-1', severity: 'high', family: 'contract', invariant: 'GET /invoices never returns a negative total.', paths: ['internal/billing/'] },
          { signature: 'sig-2', severity: 'low', family: 'contract', invariant: 'Low one.', paths: ['internal/billing/'] },
        ],
      }),
      goProfile,
    );
    const prior = bySignal(candidates, 'prior-finding');
    expect(prior).toHaveLength(1);
    expect(prior[0].invariant).toBe('GET /invoices never returns a negative total.');
  });
});

describe('generateScoutCandidates — invariant declared before execution', () => {
  const signals = base({
    changedPaths: ['internal/billing/invoice.go', 'migrations/0002.sql'],
    failures: [{ signature: 'boom', count: 2 }],
    specDiscrepancies: [{ ref: 'disc:1', direction: 'spec_ahead', summary: 'x' }],
    criticalPaths: [{ name: 'billing', pattern: 'internal/billing/**', invariant: '   ' }],
  });

  it('every candidate carries a non-empty invariant and is frozen', () => {
    const { candidates } = generateScoutCandidates(signals, goProfile);
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.invariant.trim().length).toBeGreaterThan(0);
      expect(Object.isFrozen(c)).toBe(true);
      expect(() => { (c as { invariant: string }).invariant = 'rewritten after the fact'; }).toThrow();
    }
  });

  it('a blank owner invariant is replaced by a generated one, with a warning', () => {
    const { candidates, warnings } = generateScoutCandidates(signals, goProfile);
    const cp = bySignal(candidates, 'critical-path')[0];
    expect(cp.invariant).toMatch(/billing/);
    expect(warnings.join('\n')).toMatch(/billing/);
  });

  it('ids are stable across runs and independent of input order', () => {
    const a = generateScoutCandidates(signals, goProfile).candidates.map((c) => c.id);
    const b = generateScoutCandidates({ ...signals, changedPaths: [...signals.changedPaths].reverse() }, goProfile).candidates.map((c) => c.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });
});

describe('generateScoutCandidates — executor matching', () => {
  it('binds a usable capability as executor, else records unsupported with the reason', () => {
    const { candidates } = generateScoutCandidates(
      base({ changedPaths: ['internal/billing/invoice.go', 'migrations/0002.sql'] }),
      cliProfile,
    );
    const contract = bySignal(candidates, 'change').find((c) => c.family === 'contract');
    expect(contract?.supported).toBe(true);
    expect(contract?.executor).toBe('verification-command');
    const persistence = byFamily(candidates, 'persistence')[0];
    // The Python CLI has no migrations directory, but its verification command
    // is the declared fallback precondition, so the probe still has an executor.
    expect(persistence.executor).toBe('verification-command');
  });

  it('records unsupported with the reason when no precondition is met, instead of dropping the candidate', () => {
    const { candidates } = generateScoutCandidates(
      base({ visualFindings: [{ ref: 'shot:1', route: '/home', severity: 'high', summary: 'Overlap' }] }),
      cliProfile,
    );
    const [surface] = candidates;
    expect(surface.family).toBe('surface');
    expect(surface.supported).toBe(false);
    expect(surface.executor).toBeNull();
    expect(surface.unsupportedReason).toMatch(/ui-surface/);
  });

  it('prefers a declared API journey for a contract probe when one is usable', () => {
    const { candidates } = generateScoutCandidates(base({ changedPaths: ['internal/billing/invoice.go'] }), goProfile);
    const contract = bySignal(candidates, 'change').find((c) => c.family === 'contract');
    expect(contract?.executor).toBe('api-journey:invoices');
  });
});

describe('generateScoutCandidates — bounded', () => {
  const flood = base({
    changedPaths: Array.from({ length: 400 }, (_, i) => `pkg${i}/mod/file${i}.go`),
    failures: Array.from({ length: 200 }, (_, i) => ({ signature: `sig-${i}`, count: i + 1 })),
    recentWork: Array.from({ length: 100 }, (_, i) => ({ ref: `pr:${i}`, title: 't'.repeat(5000), reviewState: 'changes_requested' as const })),
  });

  it('caps the candidate set at the default and keeps the most severe first', () => {
    const { candidates, truncated } = generateScoutCandidates(flood, goProfile);
    expect(candidates.length).toBe(DEFAULT_MAX_CANDIDATES);
    expect(truncated).toBeGreaterThan(0);
    const rank = { critical: 0, high: 1, medium: 2, low: 3 };
    for (let i = 1; i < candidates.length; i++) {
      expect(rank[candidates[i - 1].severity]).toBeLessThanOrEqual(rank[candidates[i].severity]);
    }
  });

  it('bounds every free-text field and path list', () => {
    const { candidates } = generateScoutCandidates(flood, goProfile, { maxCandidates: 500 });
    expect(candidates.length).toBeLessThanOrEqual(500);
    for (const c of candidates) {
      expect(c.title.length).toBeLessThanOrEqual(160);
      expect(c.hypothesis.length).toBeLessThanOrEqual(400);
      expect(c.invariant.length).toBeLessThanOrEqual(400);
      expect(c.paths.length).toBeLessThanOrEqual(20);
    }
  });

  it('respects a smaller configured cap', () => {
    expect(generateScoutCandidates(flood, goProfile, { maxCandidates: 5 }).candidates).toHaveLength(5);
  });
});

describe('matchesPathPattern', () => {
  it('supports exact, directory prefix, * and ** forms', () => {
    expect(matchesPathPattern('a/b/c.go', 'a/b/c.go')).toBe(true);
    expect(matchesPathPattern('a/b/c.go', 'a/b/')).toBe(true);
    expect(matchesPathPattern('a/b/c.go', 'a/**')).toBe(true);
    expect(matchesPathPattern('a/b/c.go', 'a/*.go')).toBe(false);
    expect(matchesPathPattern('a/c.go', 'a/*.go')).toBe(true);
    expect(matchesPathPattern('ab/c.go', 'a/')).toBe(false);
  });
});

describe('Quality Scout caller logic stays provider-agnostic', () => {
  it('names no provider or model in the scout modules', () => {
    for (const file of ['candidates.ts', 'selector.ts']) {
      const src = readFileSync(join(import.meta.dir, '..', 'quality-scout', file), 'utf8');
      expect(src).not.toMatch(/jev|openrouter|anthropic|openai|claude|gpt-|llama|gemini|sonnet|opus|haiku/i);
    }
  });
});
