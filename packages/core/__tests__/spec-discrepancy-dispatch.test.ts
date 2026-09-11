import { describe, test, expect, beforeEach } from 'bun:test';
import { installSpecDiscrepancyDispatchDbMock, setStore } from './_spec-discrepancy-dispatch-db-mock';

installSpecDiscrepancyDispatchDbMock();

import {
  formatDispatchBlock,
  findDispatchDiscrepancyBlock,
  type OpenDiscrepancyRow,
} from '../spec-discrepancy-dispatch';

function row(overrides: Partial<OpenDiscrepancyRow> & { specPath: string; assertionId: string; direction: OpenDiscrepancyRow['direction'] }): OpenDiscrepancyRow {
  return { evidence: null, ...overrides };
}

beforeEach(() => {
  setStore([]);
});

describe('formatDispatchBlock', () => {
  test('returns null for an empty row set', () => {
    expect(formatDispatchBlock([])).toBeNull();
  });

  test('renders the §11 heading, direction, and evidence detail for a spec_ahead row', () => {
    const block = formatDispatchBlock([
      row({
        specPath: 'docs/design/worker-mount-isolation.md',
        assertionId: 'mount-symbol',
        direction: 'spec_ahead',
        evidence: { detail: 'no exported "buildWorkerMountAllowlist" found in apps/runner/src/workers.ts' },
      }),
    ]);
    expect(block).toContain('## Spec Discrepancies You May Be Closing');
    expect(block).toContain('docs/design/worker-mount-isolation.md');
    expect(block).toContain('`mount-symbol`');
    expect(block).toContain('(spec_ahead)');
    expect(block).toContain('no exported "buildWorkerMountAllowlist" found in apps/runner/src/workers.ts');
  });

  test('renders a row with no evidence without a trailing colon', () => {
    const block = formatDispatchBlock([
      row({ specPath: 'docs/design/x.md', assertionId: 'a', direction: 'contradicted', evidence: null }),
    ]);
    expect(block).toContain('(contradicted). If you are touching');
  });

  test('renders every row in the set, one line each', () => {
    const block = formatDispatchBlock([
      row({ specPath: 'docs/design/a.md', assertionId: 'a1', direction: 'code_ahead' }),
      row({ specPath: 'docs/design/b.md', assertionId: 'b1', direction: 'contradicted' }),
    ]);
    const lines = block!.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(2);
  });
});

describe('findDispatchDiscrepancyBlock', () => {
  test('returns null without a DB read for an undeclared pathManifest', async () => {
    setStore([row({ specPath: 'docs/design/x.md', assertionId: 'a', direction: 'code_ahead' })]);
    for (const manifest of [null, undefined, [], ['**']]) {
      expect(await findDispatchDiscrepancyBlock({ workspaceId: 'ws1', pathManifest: manifest as any })).toBeNull();
    }
  });

  test('returns null when the workspace has no open rows', async () => {
    setStore([]);
    const result = await findDispatchDiscrepancyBlock({
      workspaceId: 'ws1',
      pathManifest: ['apps/runner/src/workers.ts'],
    });
    expect(result).toBeNull();
  });

  test('matches an open row by resolved code path extracted from evidence, any direction', async () => {
    setStore([
      row({
        specPath: 'docs/design/worker-mount-isolation.md',
        assertionId: 'mount-symbol',
        direction: 'spec_ahead',
        evidence: { detail: 'no exported "buildWorkerMountAllowlist" found in apps/runner/src/workers.ts' },
      }),
    ]);
    const result = await findDispatchDiscrepancyBlock({
      workspaceId: 'ws1',
      pathManifest: ['apps/runner/src/workers.ts'],
    });
    expect(result).toContain('mount-symbol');
    expect(result).toContain('spec_ahead');
  });

  test('matches on the spec doc path itself', async () => {
    setStore([row({ specPath: 'docs/design/loop-until-verified.md', assertionId: 'loop-config-col', direction: 'code_ahead' })]);
    const result = await findDispatchDiscrepancyBlock({
      workspaceId: 'ws1',
      pathManifest: ['docs/design/loop-until-verified.md'],
    });
    expect(result).toContain('loop-config-col');
  });

  test('an unrelated pathManifest matches nothing', async () => {
    setStore([row({ specPath: 'docs/design/worker-mount-isolation.md', assertionId: 'mount-symbol', direction: 'contradicted' })]);
    const result = await findDispatchDiscrepancyBlock({
      workspaceId: 'ws1',
      pathManifest: ['apps/web/src/app/app/(protected)/releases/page.tsx'],
    });
    expect(result).toBeNull();
  });
});
