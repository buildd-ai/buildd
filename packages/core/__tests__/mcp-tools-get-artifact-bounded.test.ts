import { describe, it, expect } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const ctx: ActionContext = { authType: 'oauth', getWorkspaceId: async () => null, getLevel: async () => 'worker' };
const ID = '11111111-1111-4111-8111-111111111111';
const base = { id: ID, title: 'Ops manual', type: 'content', createdAt: 'x', updatedAt: 'y', currentRevision: 2, revision: { revision: 2, contentHash: 'ab12' } };

function apiReturning(artifact: Record<string, unknown>, seen: string[]): ApiFn {
  return (async (endpoint: string) => { seen.push(endpoint); return { artifact: { ...base, ...artifact } }; }) as ApiFn;
}
const run = async (api: ApiFn, params: Record<string, unknown>) => String((await handleBuilddAction(api, 'get_artifact', { artifactId: ID, ...params }, ctx)).content[0].text);

describe('get_artifact: bounded reads', () => {
  it('asks for view=auto by default, and full=true asks for the whole body', async () => {
    const seen: string[] = [];
    await run(apiReturning({ content: 'short', read: { view: 'full', text: 'short', chars: 5 } }, seen), {});
    await run(apiReturning({ content: 'long', read: { view: 'full', text: 'long', chars: 4 } }, seen), { full: true });
    await run(apiReturning({ content: null, read: { view: 'section', chars: 9, section: { id: 's2', title: 'B', chars: 3 }, text: 'abc', truncated: false } }, seen), { view: 'section', section: 's2', revision: 1 });
    expect(seen).toEqual([
      `/api/artifacts/${ID}?view=auto`,
      `/api/artifacts/${ID}?view=full`,
      `/api/artifacts/${ID}?revision=1&view=section&section=s2`,
    ]);
  });

  it('an outline lists section ids, sizes and how to read further, with the revision and hash', async () => {
    const out = await run(apiReturning({
      content: null,
      read: { view: 'outline', chars: 650_000, sections: [{ id: 's1', level: 1, title: 'Ops manual', chars: 650_000 }, { id: 's2', level: 2, title: 'Rotating credentials', chars: 16_500 }] },
    }, []), {});
    expect(out).toContain('**Revision:** 2 of 2 (sha256 ab12)');
    expect(out).toContain('## Outline (650,000 characters, 2 sections)');
    expect(out).toContain('  - s2: Rotating credentials (16,500 chars)');
    expect(out).toContain('view "section"');
    expect(out).not.toContain('## Content');
  });

  it('grep shows line numbers and offsets so a range can follow', async () => {
    const out = await run(apiReturning({
      content: null,
      read: { view: 'grep', chars: 100, pattern: 'signing key', truncated: false, matches: [{ line: 812, offset: 40_210, text: 'To rotate a signing key, revoke the old key last.' }] },
    }, []), { view: 'grep', grep: 'signing key' });
    expect(out).toContain('1 match(es) for "signing key"');
    expect(out).toContain('line 812 (offset 40,210):');
  });
});
