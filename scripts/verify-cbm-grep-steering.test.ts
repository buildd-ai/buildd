import { describe, it, expect } from 'bun:test';
import { join } from 'path';

import {
  CBM_STEERING_REQUIREMENTS,
  evaluateCbmSteering,
  findSteeringSignals,
  formatSteeringReport,
  normalizeDescription,
  pinnedCbmVersion,
} from './verify-cbm-grep-steering';

/**
 * Unit half of the CBM grep-steering gate.
 *
 * The gate itself needs the real binary (scripts/verify-cbm-grep-steering.ts runs
 * a tools/list handshake in .github/workflows/worker-image.yml). What is testable
 * without a binary is the part most likely to rot: the matching rule, and whether
 * the rule can actually FAIL. Both halves import the same
 * CBM_STEERING_REQUIREMENTS / evaluateCbmSteering, so "steering present" is
 * defined in exactly one place.
 */

const REPO_ROOT = join(import.meta.dir, '..');

/**
 * The real descriptions as advertised by the pinned 0.10.8 build, trimmed to the
 * load-bearing opening. Captured from a live `tools/list` handshake, not from
 * upstream docs.
 */
const REAL_0_10_8 = {
  search_graph:
    'Search the code knowledge graph for functions, classes, routes, and variables. ' +
    'Use INSTEAD OF grep/glob when finding code definitions, implementations, or ' +
    'relationships. Three search modes: (1) query=\'update settings\' for BM25 ranked ' +
    'full-text search with camelCase splitting and structural label boosting.',
  trace_path:
    'Trace paths through the code graph. Modes: calls (callers/callees), data_flow ' +
    '(value propagation with args at each hop), cross_service (through HTTP/async Route ' +
    'nodes). Use INSTEAD OF grep for callers, dependencies, impact analysis, or data ' +
    'flow tracing. RESPONSE: prefix-grouped tree rows.',
};

/** The same build with only the steering sentence removed — the upstream regression. */
const STRIPPED = {
  search_graph: REAL_0_10_8.search_graph.replace(
    'Use INSTEAD OF grep/glob when finding code definitions, implementations, or relationships. ',
    '',
  ),
  trace_path: REAL_0_10_8.trace_path.replace(
    'Use INSTEAD OF grep for callers, dependencies, impact analysis, or data flow tracing. ',
    '',
  ),
};

const toolList = (descriptions: Record<string, string>) =>
  Object.entries(descriptions).map(([name, description]) => ({ name, description }));

describe('CBM grep-steering matcher', () => {
  it('passes the descriptions the pinned build actually advertises', () => {
    // Guards the stripping fixtures below: if this ever fails, the fixtures no
    // longer contain the sentence they claim to remove.
    expect(REAL_0_10_8.search_graph).toContain('INSTEAD OF grep');
    const result = evaluateCbmSteering(toolList(REAL_0_10_8));
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checked.every(entry => entry.ok)).toBe(true);
  });

  it('FAILS when the steering sentence is stripped, naming every tool that lost it', () => {
    const result = evaluateCbmSteering(toolList(STRIPPED));
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(2);
    for (const requirement of CBM_STEERING_REQUIREMENTS) {
      expect(result.failures.join('\n')).toContain(`tool '${requirement.tool}'`);
      expect(result.failures.join('\n')).toContain(requirement.routes);
    }
    expect(result.failures.join('\n')).toContain('no longer mentions grep or glob at all');
    // The message has to say what it costs, not just that a string is missing.
    expect(result.failures.join('\n')).toContain('vendor-side half');
  });

  it('FAILS when grep is still mentioned but no longer as a displaced alternative', () => {
    // The decay mode: `search_code`-style neutral prose is not steering.
    const result = evaluateCbmSteering([
      {
        name: 'search_graph',
        description: 'Search the graph. Finds text patterns via grep, then enriches them.',
      },
      { name: 'trace_path', description: REAL_0_10_8.trace_path },
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toContain('decayed from steering into description');
  });

  it('FAILS CLOSED on an empty tools list rather than reading it as "steering present"', () => {
    const result = evaluateCbmSteering([]);
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toContain('NO tools');
  });

  it('FAILS CLOSED when a required tool is not advertised at all', () => {
    const result = evaluateCbmSteering([
      { name: 'search_graph', description: REAL_0_10_8.search_graph },
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toContain("tool 'trace_path' is not advertised");
  });

  it('FAILS CLOSED on an empty or non-string description', () => {
    const empty = evaluateCbmSteering([
      { name: 'search_graph', description: '   ' },
      { name: 'trace_path', description: REAL_0_10_8.trace_path },
    ]);
    expect(empty.ok).toBe(false);
    expect(empty.failures.join('\n')).toContain('empty description');

    const missing = evaluateCbmSteering([
      { name: 'search_graph' },
      { name: 'trace_path', description: REAL_0_10_8.trace_path },
    ]);
    expect(missing.ok).toBe(false);
  });

  describe('tolerance — harmless rewording must not fail the gate', () => {
    const tolerated = [
      'Use in place of grep when looking for definitions.',
      'Prefer this rather than grep for finding implementations.',
      'use\n  INSTEAD   OF\n  GLOB when locating symbols', // wrapping + case + whitespace
      'Reach for this over grep.',
      'Do not use grep to find callers; use this.',
      'Use this before reaching for ripgrep.',
      'Avoid grep for structural questions — this answers them.',
      'Use instead of a repo-wide glob across the whole tree.',
    ];
    for (const description of tolerated) {
      it(`accepts: ${description.replace(/\s+/g, ' ').slice(0, 48)}`, () => {
        expect(findSteeringSignals(description).displacesGrep).toBe(true);
      });
    }
  });

  describe('rejection — the mention alone is not steering', () => {
    const rejected = [
      'Finds text patterns via grep, then enriches results with the graph.',
      // Steering TOWARD grep. Matching this would be worse than matching nothing.
      'If the response carries a coverage_note, prefer grep there and treat the source as truth.',
      'Search the code knowledge graph for functions, classes, routes, and variables.',
      'Use this for finding code definitions, implementations, or relationships.',
    ];
    for (const description of rejected) {
      it(`rejects: ${description.slice(0, 48)}`, () => {
        expect(findSteeringSignals(description).displacesGrep).toBe(false);
      });
    }
  });

  it('normalizes case and whitespace before matching', () => {
    expect(normalizeDescription('  Use   INSTEAD\n OF grep ')).toBe('use instead of grep');
  });
});

describe('CBM grep-steering report', () => {
  it('tells the reader a bump is still allowed and the check must not be deleted', () => {
    const report = formatSteeringReport(evaluateCbmSteering(toolList(STRIPPED)));
    expect(report).toContain('NOT a reason to refuse every bump');
    expect(report).toContain('Do not delete the check');
    expect(report).toContain('buildCbmGuidanceBody');
  });
});

describe('the gate is a property check, not a version ceiling', () => {
  it('hardcodes no CBM version in its executable code', async () => {
    // Bun.file, not readFileSync: a sibling file mocking 'fs' would hand us a stub.
    const source = await Bun.file(join(REPO_ROOT, 'scripts/verify-cbm-grep-steering.ts')).text();
    // Comments may cite the version that was measured — that is history, not a
    // ceiling. Code may not: a literal there would be a comparison, i.e. a freeze.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const versionLiterals = [...code.matchAll(/\b\d+\.\d+\.\d+\b/g)].map(match => match[0]);
    expect(versionLiterals).toEqual([]);
  });

  it('reads the pin from the Dockerfile when it needs one', async () => {
    const dockerfile = await Bun.file(join(REPO_ROOT, 'docker/worker/Dockerfile')).text();
    expect(pinnedCbmVersion(dockerfile)).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pinnedCbmVersion('FROM scratch\n')).toBeNull();
  });
});

describe('the gate actually runs in CI', () => {
  /**
   * A check nothing invokes is the failure mode this whole exercise exists to
   * prevent. worker-image.yml is path-filtered, so the script must be wired into
   * BOTH the step list and the filters — otherwise a bump that touches only the
   * Dockerfile would run the checksum gate and skip this one.
   */
  it('is invoked by worker-image.yml and included in its path filters', async () => {
    const workflow = await Bun.file(
      join(REPO_ROOT, '.github/workflows/worker-image.yml'),
    ).text();
    expect(workflow).toContain('bun scripts/verify-cbm-grep-steering.ts');
    // Once per push filter, once per pull_request filter, plus the run step.
    const references = [...workflow.matchAll(/verify-cbm-grep-steering\.ts/g)];
    expect(references.length).toBeGreaterThanOrEqual(3);
    // The bump surfaces themselves must keep triggering the workflow.
    expect(workflow).toContain('docker/worker/Dockerfile');
    expect(workflow).toContain('apps/runner/install.sh');
  });
});
