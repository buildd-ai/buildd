import { describe, test, expect } from 'bun:test';
import { AGENT_INSTRUCTIONS_MARKER, findInstructionLeaks } from '../agent-instruction-leak';
import { BUILDD_AGENTS_BEGIN } from '../../../apps/runner/src/codex-instructions';

describe('findInstructionLeaks', () => {
  test('marker matches what the runner writes', () => {
    expect(BUILDD_AGENTS_BEGIN).toContain(AGENT_INSTRUCTIONS_MARKER);
  });
  test('flags a file whose added lines carry the marker', () => {
    const patch = `@@ -1,1 +1,3 @@\n rules\n+<!-- ${AGENT_INSTRUCTIONS_MARKER} (x) -->\n+body`;
    expect(findInstructionLeaks([{ filename: 'CLAUDE.md', patch }, { filename: 'a.ts', patch: '+ok' }])).toEqual(['CLAUDE.md']);
  });
  test('ignores removed and context lines and missing patches', () => {
    const patch = `@@ -1,2 +1,1 @@\n-<!-- ${AGENT_INSTRUCTIONS_MARKER} -->\n ${AGENT_INSTRUCTIONS_MARKER}`;
    expect(findInstructionLeaks([{ filename: 'CLAUDE.md', patch }, { filename: 'big.bin' }])).toEqual([]);
  });
});
