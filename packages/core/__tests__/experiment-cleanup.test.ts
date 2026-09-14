import { describe, it, expect } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

// No `db` mock in this file, deliberately. Everything here is either a pure
// string builder or a WHERE fragment, and a mocked `db` makes a predicate
// unobservable — so the fragment is rendered with the real dialect and asserted
// as SQL text plus params.
import {
  EXPERIMENT_CLEANUP_SIGNATURE_NS,
  EXPERIMENT_CLEANUP_TITLE_PREFIX,
  buildExperimentCleanupDescription,
  cleanupNoticeLine,
  cleanupTaskWorkspaceScope,
  experimentCleanupSignature,
  experimentCleanupTitle,
  memoryDigestCleanupSpec,
} from '../experiment-cleanup';
import { normalizeErrorSignature } from '../subject-anchor-extractor';
import { READOUT_POLICY_VERSION } from '../memory-digest-readout';

const dialect = new PgDialect();
function render(frag: unknown): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(frag as never);
  return { sql: q.sql.replace(/\s+/g, ' ').trim(), params: q.params };
}

const spec = memoryDigestCleanupSpec({
  verdict: 'powered',
  artifactUrl: 'https://buildd.dev/app/artifacts/artifact-placeholder',
});
const description = buildExperimentCleanupDescription(spec);

describe('the subject signature', () => {
  it('is namespaced on the cleanup namespace and the experiment slug', () => {
    expect(experimentCleanupSignature('some-slug')).toBe(
      `${EXPERIMENT_CLEANUP_SIGNATURE_NS}:some-slug`,
    );
  });

  it('survives normalizeErrorSignature, so the anchor is actually persisted', () => {
    // The whole point of the anchor is that buildd's own subject dedupe becomes
    // a second line of defence behind the once-ever claim. An errorSignature
    // the extractor rejects yields NO anchor at all (extractSubjectAnchor
    // returns null for a system context whose signature does not normalize),
    // which would silently remove that second line without failing anything.
    const sig = experimentCleanupSignature(spec.slug);
    expect(normalizeErrorSignature(sig)).toBe(sig);
  });

  it('is stable for the memory-digest experiment', () => {
    expect(spec.slug).toBe(READOUT_POLICY_VERSION);
    expect(normalizeErrorSignature(experimentCleanupSignature(READOUT_POLICY_VERSION))).not.toBeNull();
  });
});

describe('the title', () => {
  it('carries the prefix and the experiment slug', () => {
    expect(experimentCleanupTitle(spec)).toStartWith(EXPERIMENT_CLEANUP_TITLE_PREFIX);
    expect(experimentCleanupTitle(spec)).toContain(spec.slug);
  });
});

describe('the description states what to remove', () => {
  it('names the manifest entry and the effect of removing it', () => {
    expect(description).toContain('cron-manifest.json');
    expect(description).toMatch(/daily tick/i);
  });

  it('requires a PR to the declared base branch', () => {
    expect(spec.baseBranch).toBe('dev');
    expect(description).toMatch(/open a PR to `dev`/i);
  });

  it('scopes itself to scaffolding, not to the experiment', () => {
    expect(description).toMatch(/scaffolding/i);
  });
});

/**
 * THE safety property of this whole feature.
 *
 * An agent handed "clean up the finished experiment" can plausibly delete the
 * readout module, the CLI, the pin guard or the published artifact — every one
 * of which is either reusable or is the record of the result. The prohibitions
 * are therefore stated explicitly in the description rather than left to
 * judgement, and each named asset is pinned here so a future edit that drops
 * one from the spec fails a test rather than quietly widening the blast radius.
 *
 * The substance is pinned (the asset paths), not the prose around them.
 */
describe('the description states the prohibitions explicitly', () => {
  const MUST_BE_PROTECTED = [
    // The reusable half — the next experiment computes its readout with these.
    'packages/core/memory-digest-readout.ts',
    'packages/core/memory-digest-readout-source.ts',
    // The CLI and its package script: how anyone re-reads the analysis once the
    // cron is gone.
    'packages/core/scripts/memory-digest-readout.ts',
    'readout:memory-digest',
    // The policy-version pin guards, which must outlive the verdict.
    'packages/core/__tests__/memory-digest-readout-policy-pin.test.ts',
    'apps/runner/__tests__/unit/memory-digest-policy-version-pin.test.ts',
    // The published verdict, and the claim row that keeps the cron retired.
    'memory-digest-readout:',
    'system_cache',
    // Arm assignment: touching it is the experiment's DECISION, not cleanup.
    'apps/runner/src/memory-digest-policy.ts',
  ];

  it('has a prohibition section at all', () => {
    expect(description).toMatch(/DO NOT/);
  });

  for (const asset of MUST_BE_PROTECTED) {
    it(`protects ${asset}`, () => {
      expect(description).toContain(asset);
    });
  }

  it('lists every protected asset under the prohibition heading, not elsewhere', () => {
    // A path mentioned in the "DO" section would read as licence to change it.
    const prohibitions = description.slice(description.indexOf('DO NOT'));
    for (const asset of MUST_BE_PROTECTED) {
      expect(prohibitions).toContain(asset);
    }
  });
});

describe('the route is an optional judgement call, not an instruction', () => {
  it('says the route becomes unreferenced', () => {
    expect(description).toContain('apps/web/src/app/api/cron/memory-digest-readout');
    expect(description).toMatch(/unreferenced/i);
  });

  it('says removing it is optional and not required by this task', () => {
    const optional = description.slice(description.indexOf('Optional'));
    expect(optional).toMatch(/NOT required by this task/i);
    expect(optional).toMatch(/judge?ment/i);
  });

  it('names the gate a kept route still has to satisfy', () => {
    expect(description).toContain('scripts/cron-coverage.test.ts');
  });
});

describe('the two-stage split is in the description', () => {
  it('says the schedule retires now because the stopping rule is satisfied', () => {
    expect(description).toMatch(/stage one/i);
    expect(description).toMatch(/more data adds nothing/i);
  });

  it('says the pin guard is stage two and stays until the decision is recorded', () => {
    expect(description).toMatch(/stage two/i);
    expect(description).toMatch(/until the .*decision is recorded/i);
    // The reason, not just the rule: a later retrieval change with no version
    // bump would rebase a cohort someone may still re-analyse.
    expect(description).toMatch(/rebase/i);
  });

  it('says only stage one is automated', () => {
    expect(description).toMatch(/only stage one/i);
  });
});

describe('the decision is explicitly not this task', () => {
  it('says keep-or-revert is a separate human call', () => {
    expect(description).toMatch(/keep(ing)? or revert/i);
    expect(description).toMatch(/human/i);
  });

  it('forbids assuming the decision or changing run-time behaviour', () => {
    expect(description).toMatch(/do not assume/i);
    expect(description).toMatch(/run-?time behaviour/i);
  });
});

describe('the spec carries the machine-readable half', () => {
  it('declares a narrow path manifest', () => {
    expect(spec.pathManifest).toContain('cron-manifest.json');
    // Never the whole tree: the manifest is what the claim-time overlap guard
    // and the orchestrator read, and `**` makes it meaningless.
    expect(spec.pathManifest).not.toContain('**');
  });

  it('carries the artifact link when there is one', () => {
    expect(description).toContain('https://buildd.dev/app/artifacts/artifact-placeholder');
  });

  it('says so plainly when there is no artifact link', () => {
    const noArtifact = buildExperimentCleanupDescription(
      memoryDigestCleanupSpec({ verdict: 'stalled', artifactUrl: null }),
    );
    expect(noArtifact).not.toContain('https://buildd.dev/app/artifacts');
    expect(noArtifact).toMatch(/artifact/i);
  });
});

describe('cleanupNoticeLine', () => {
  it('names the filed task so the push is checkable', () => {
    const line = cleanupNoticeLine('task-id-placeholder', null);
    expect(line).toContain('task-id-placeholder');
    expect(line.split('\n')).toHaveLength(1);
  });

  it('says a cleanup task was NOT filed rather than staying silent', () => {
    // Silence here would be indistinguishable from "filed", and the recipient
    // would never learn the manual step is back on them.
    const line = cleanupNoticeLine(null, 'boom');
    expect(line).toMatch(/no cleanup task/i);
    expect(line).toMatch(/by hand/i);
    expect(line.split('\n')).toHaveLength(1);
  });
});

describe('cleanupTaskWorkspaceScope', () => {
  it('keys the workspace lookup on workspaces.id', () => {
    const { sql, params } = render(cleanupTaskWorkspaceScope('ws-placeholder'));
    expect(sql).toBe('"workspaces"."id" = $1');
    expect(params).toEqual(['ws-placeholder']);
  });
});
