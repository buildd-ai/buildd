import { describe, test, expect, mock, beforeEach } from 'bun:test';

const mockGithubApi = mock(async (..._a: any[]): Promise<any> => ({ files: [] }));
mock.module('@/lib/github', () => ({ githubApi: mockGithubApi }));

import { findLeakedInstructionFiles } from './agent-instruction-guard';

describe('findLeakedInstructionFiles', () => {
  beforeEach(() => mockGithubApi.mockReset());

  test('names the file whose diff adds the instruction block', async () => {
    mockGithubApi.mockResolvedValue({
      files: [{ filename: 'CLAUDE.md', patch: '@@ -1 +1,2 @@\n x\n+<!-- BEGIN buildd agent instructions (auto-generated; do not edit) -->' }],
    });
    expect(await findLeakedInstructionFiles(1, 'o/r', 'dev', 'b')).toEqual(['CLAUDE.md']);
    expect(mockGithubApi.mock.calls[0][1]).toContain('/compare/dev...b');
  });

  test('clean diff passes', async () => {
    mockGithubApi.mockResolvedValue({ files: [{ filename: 'a.ts', patch: '+ok' }] });
    expect(await findLeakedInstructionFiles(1, 'o/r', 'dev', 'b')).toEqual([]);
  });

  test('fails open when GitHub errors', async () => {
    mockGithubApi.mockRejectedValue(new Error('boom'));
    expect(await findLeakedInstructionFiles(1, 'o/r', 'dev', 'b')).toEqual([]);
  });
});
