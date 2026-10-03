import { describe, test, expect } from 'bun:test';
import {
  ONBOARDING_INTERVIEW,
  MAX_SPEC_CAPABILITIES,
  findVagueness,
  rewriteModals,
  validateInterviewAnswers,
  type SpecInterviewAnswers,
} from '@buildd/shared';
import { authorSpec, buildAuthorSpecTaskDescription, resolveSpecsRoot, DEFAULT_SPECS_ROOT } from '../onboarding-spec';
import { ingestFiles } from '../knowledge-store/ingest';
import type { KnowledgeStore, QueryParams, QueryResult, UpsertChunk } from '../knowledge-store/types';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';

// A Python service with none of buildd's layout, names or toolchain.
const FILES = [
  'pyproject.toml',
  'src/ledger/__init__.py',
  'src/ledger/posting.py',
  'src/ledger/api/routes.py',
  'tests/test_posting.py',
  'docs/notes.md',
];

function answers(over: Partial<SpecInterviewAnswers> = {}): SpecInterviewAnswers {
  return {
    title: 'Ledger',
    description: 'Ledger records double-entry postings for small finance teams. Accountants read it.',
    capabilities: [
      {
        name: 'post a balanced entry',
        invariants: ['the sum of debits equals the sum of credits for every stored entry'],
        accepted: { given: 'an entry with debits 10 and credits 10', when: 'it is posted', then: 'it is stored and returned with an id' },
        rejected: { given: 'an entry with debits 10 and credits 9', when: 'it is posted', then: 'it is rejected with HTTP 422 and nothing is stored' },
        codePaths: ['src/ledger/posting.py', 'src/ledger/api/', 'src/ledger/does_not_exist.py'],
      },
      {
        name: 'close a period',
        invariants: ['a closed period accepts no new entries'],
        accepted: { when: 'an open period is closed', then: 'its status becomes closed' },
        rejected: { when: 'an entry is posted to a closed period', then: 'the post is rejected with HTTP 409' },
      },
    ],
    outOfScope: ['Multi-currency conversion'],
    verification: ['tests/test_posting.py', 'run pytest', 'tests/test_ghost.py'],
    protectedAreas: ['src/ledger/posting.py', 'the audit log format'],
    ...over,
  };
}

const base = { files: FILES, specsRoot: null, mirrorSpecs: [] as string[], owner: 'octocat', today: '2026-10-01' };

function ok(over: Partial<Parameters<typeof authorSpec>[0]> = {}) {
  const r = authorSpec({ ...base, answers: answers(), ...over });
  if (!r.ok) throw new Error(`expected ok: ${JSON.stringify(r.errors)}`);
  return r;
}

const frontmatter = (md: string) => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) throw new Error('no frontmatter');
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
};
const blocks = (md: string) => md.split(/^## /m).slice(1);

describe('interview definition', () => {
  test('defines Q1-Q8 once, with only Q8 targeting the merge policy', () => {
    expect(ONBOARDING_INTERVIEW.map((q) => q.id)).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8']);
    expect(ONBOARDING_INTERVIEW.filter((q) => q.target === 'merge-policy').map((q) => q.id)).toEqual(['Q8']);
  });

  test('vague answers are flagged for re-asking, specific ones are not', () => {
    expect(findVagueness('it works properly')).toContain('properly');
    expect(findVagueness('ok')).toContain('too short');
    expect(findVagueness('the sum of debits equals the sum of credits')).toBeNull();
  });

  test('should/may are rewritten to MUST / MUST NOT', () => {
    expect(rewriteModals('It should reject bad input and may not retry').text).toBe('It MUST reject bad input and MUST NOT retry');
    expect(rewriteModals('already MUST').changed).toBe(false);
  });

  test('validateInterviewAnswers reports where to re-ask', () => {
    expect(validateInterviewAnswers(answers())).toEqual([]);
    const bad = answers();
    bad.capabilities[0].invariants = ['it works properly'];
    delete (bad.capabilities[1] as any).rejected;
    const paths = validateInterviewAnswers(bad).map((i) => i.path);
    expect(paths).toContain('capabilities[0].invariants[0]');
    expect(paths).toContain('capabilities[1].rejected');
    expect(validateInterviewAnswers({ ...answers(), capabilities: [] }).map((i) => i.path)).toContain('capabilities');
    const many = answers({ capabilities: Array.from({ length: MAX_SPEC_CAPABILITIES + 1 }, () => answers().capabilities[0]) });
    expect(validateInterviewAnswers(many).map((i) => i.path)).toContain('capabilities');
  });
});

describe('authorSpec: where the file goes', () => {
  test('one flat file under the detected spec root', () => {
    const r = ok({ specsRoot: 'specifications' });
    expect(r.path).toBe('specifications/ledger.md');
    expect(r.path.split('/').length).toBe(2);
  });

  test('no detected root: the default from the format doc', () => {
    expect(ok().path).toBe(`${DEFAULT_SPECS_ROOT}/ledger.md`);
  });

  test('resolveSpecsRoot prefers the configured root, else detection, else null', () => {
    expect(resolveSpecsRoot(['docs/specs/a.md'], 'custom/specs/')).toBe('custom/specs');
    expect(resolveSpecsRoot(['docs/specs/a.md'], undefined)).toBe('docs/specs');
    expect(resolveSpecsRoot(['src/a.py'], undefined)).toBeNull();
  });

  test('an existing file at the path is a conflict, not an overwrite', () => {
    const r = authorSpec({ ...base, answers: answers(), files: [...FILES, 'docs/specs/ledger.md'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.conflict).toBe(true);
  });

  test('the slug is derived from the title, never from a path', () => {
    const r = ok({ answers: answers({ title: '../../Evil  Name!' }) });
    expect(r.path).toBe('docs/specs/evil-name.md');
  });

  test('a title with no usable characters is rejected', () => {
    const r = authorSpec({ ...base, answers: answers({ title: '!!!' }) });
    expect(r.ok).toBe(false);
  });
});

describe('authorSpec: frontmatter (AC-12)', () => {
  test('carries every required field of the default format, status draft', () => {
    const fm = frontmatter(ok().markdown);
    for (const k of ['title', 'status', 'owner', 'last_verified', 'summary', 'domain']) {
      expect(fm[k], k).toBeTruthy();
    }
    expect(fm.status).toBe('draft');
    expect(fm.owner).toBe('octocat');
    expect(fm.last_verified).toBe('2026-10-01');
    expect(fm.title).toBe('Ledger');
    expect(fm.last_verified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('summary is one sentence, present tense, states a MUST, no leading [', () => {
    const { summary } = frontmatter(ok().markdown);
    expect(summary).toContain('MUST');
    expect(summary.startsWith('[')).toBe(false);
    expect(summary.length).toBeLessThanOrEqual(220);
    expect(summary.match(/[.!?](\s|$)/g)?.length).toBe(1);
  });

  test('a description sentence that already states a MUST becomes the summary', () => {
    const r = ok({ answers: answers({ description: 'Ledger MUST keep every posting balanced. Accountants read it.' }) });
    expect(frontmatter(r.markdown).summary).toBe('Ledger MUST keep every posting balanced.');
  });

  test('status is draft even when the answers try to say otherwise', () => {
    const r = ok({ answers: { ...answers(), status: 'active' } as any });
    expect(frontmatter(r.markdown).status).toBe('draft');
  });

  test('a summary containing a colon is quoted so the frontmatter stays flat YAML', () => {
    const r = ok({ answers: answers({ description: 'Ledger MUST post: debits equal credits. Accountants read it.' }) });
    expect(frontmatter(r.markdown).summary.startsWith('"')).toBe(true);
  });
});

// A minimal in-memory KnowledgeStore whose `query` actually does lexical
// substring matching over what `upsert` stored, instead of the always-empty
// `query` every other mock store in this codebase uses. spec_compare needs a
// store that can genuinely return what was ingested so this test proves
// retrievability, not just that ingestion didn't throw.
function makeLexicalStore(): KnowledgeStore {
  const byNamespace = new Map<string, UpsertChunk[]>();
  return {
    async upsert(namespace, chunks) {
      byNamespace.set(namespace, [...(byNamespace.get(namespace) ?? []), ...chunks]);
    },
    async query(namespace: string, params: QueryParams): Promise<QueryResult[]> {
      const chunks = byNamespace.get(namespace) ?? [];
      const terms = params.text.toLowerCase().split(/\s+/).filter(Boolean);
      const corpus = namespace.endsWith(':code') ? 'code' : 'docs';
      return chunks
        .map((c) => {
          const haystack = `${c.lexicalText ?? c.content}`.toLowerCase();
          const hits = terms.filter((t) => haystack.includes(t)).length;
          return { c, hits };
        })
        .filter((x) => x.hits > 0)
        .sort((a, b) => b.hits - a.hits)
        .map(({ c, hits }): QueryResult => ({
          id: c.id,
          namespace,
          corpus,
          sourceType: c.sourceType,
          sourcePath: c.sourcePath ?? null,
          sourceUrl: c.sourceUrl ?? null,
          content: c.content,
          metadata: c.metadata ?? {},
          score: hits / terms.length,
        }));
    },
    async delete() {},
    async deleteBySource(namespace, selector) {
      const existing = byNamespace.get(namespace) ?? [];
      byNamespace.set(namespace, existing.filter((c) => c.sourcePath !== selector.sourcePath));
    },
    async listNamespaces() {
      return [...byNamespace.keys()];
    },
  };
}

describe('authorSpec → spec_compare retrieval (AC-12)', () => {
  test('a spec authored by onboarding is retrievable by spec_compare once indexed through the real ingest path', async () => {
    const WS_ID = 'ws-onboarding-1';
    const r = ok();
    const store = makeLexicalStore();

    // The same path every real spec file takes into the knowledge store:
    // fileToChunks (via chunkMarkdown) -> upsert, under {workspaceId}:docs —
    // the exact namespace spec_compare reads.
    await ingestFiles(store, WS_ID, 'docs', [{ path: r.path, content: r.markdown }]);

    const ctx: ActionContext = {
      workspaceId: WS_ID,
      getWorkspaceId: async () => WS_ID,
      getLevel: async () => 'admin',
      knowledgeStore: store,
    } as unknown as ActionContext;

    const result = await handleBuilddAction(
      (async () => ({})) as unknown as ApiFn,
      'spec_compare',
      { feature: 'post a balanced entry' },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const out = result.content[0].text;
    expect(out).toContain('SPEC evidence');
    expect(out).toContain(r.path);
  });
});

describe('authorSpec: blocks (AC-11)', () => {
  test('one ## block per capability, the first is primary', () => {
    const bs = blocks(ok().markdown);
    expect(bs.length).toBe(2);
    expect(bs[0].startsWith('Post a balanced entry')).toBe(true);
    expect(bs[1].startsWith('Close a period')).toBe(true);
  });

  test('every block has a statement, invariants, >= 3 ACs and out of scope', () => {
    for (const b of blocks(ok().markdown)) {
      expect(b).toContain('**Capability statement**:');
      expect(b).toContain('**Invariants**:');
      expect(b).toContain('**Acceptance criteria**:');
      expect(b).toContain('**Code surface**:');
      expect(b).toContain('**Out of scope**:');
      expect(b.match(/^- AC-\d+: /gm)!.length).toBeGreaterThanOrEqual(3);
    }
  });

  test('each block has exactly one rejection AC built from the rejected example', () => {
    const [first, second] = blocks(ok().markdown);
    expect(first.match(/\(rejection case\)/g)!.length).toBe(1);
    expect(first).toMatch(/AC-\d+: GIVEN an entry with debits 10 and credits 9 WHEN it is posted THEN it is rejected with HTTP 422 and nothing is stored \(rejection case\)/);
    expect(second).toMatch(/AC-\d+: WHEN an entry is posted to a closed period THEN the post is rejected with HTTP 409 \(rejection case\)/);
  });

  test('the working example and each invariant also become ACs', () => {
    const [first] = blocks(ok().markdown);
    expect(first).toMatch(/GIVEN an entry with debits 10 and credits 10 WHEN it is posted THEN it is stored and returned with an id/);
    expect(first).toMatch(/THEN the sum of debits equals the sum of credits for every stored entry/);
  });

  test('AC numbers are unique across the file', () => {
    const nums = ok().markdown.match(/^- (AC-\d+):/gm)!;
    expect(new Set(nums).size).toBe(nums.length);
  });

  test('contains no "should" or "may": owner wording is rewritten to MUST', () => {
    const a = answers();
    a.capabilities[0].invariants = ['the ledger should never store an unbalanced entry'];
    a.capabilities[1].rejected.then = 'the post may not succeed and is rejected with HTTP 409';
    a.outOfScope = ['It should not convert currency'];
    a.description = 'Ledger may be used by teams. Accountants read it.';
    const r = ok({ answers: a });
    expect(r.markdown).not.toMatch(/\b(should|may)\b/i);
    expect(r.markdown).toContain('the ledger MUST never store an unbalanced entry');
    expect(r.warnings.join(' ')).toMatch(/rewrote/i);
  });

  test('out of scope is the owner list; an empty answer says so', () => {
    expect(ok().markdown).toContain('- Multi-currency conversion');
    const empty = ok({ answers: answers({ outOfScope: [] }) });
    expect(blocks(empty.markdown)[0]).toMatch(/\*\*Out of scope\*\*:\n\n- None declared/);
  });
});

describe('authorSpec: only verifiable claims', () => {
  test('code surface keeps only paths that exist, directories included', () => {
    const [first, second] = blocks(ok().markdown);
    expect(first).toContain('`src/ledger/posting.py`');
    expect(first).toContain('`src/ledger/api/`');
    expect(first).not.toContain('does_not_exist');
    expect(second).toMatch(/\*\*Code surface\*\*:\n\n- None recorded/);
  });

  test('dropped paths are reported, not silently lost', () => {
    const r = ok();
    expect(r.dropped.codePaths).toEqual(['src/ledger/does_not_exist.py']);
    expect(r.warnings.join(' ')).toContain('does_not_exist');
  });

  test('path escapes and absolute paths are never kept', () => {
    const a = answers();
    a.capabilities[0].codePaths = ['../secrets.py', '/etc/passwd', './src/ledger/posting.py'];
    const r = ok({ answers: a });
    expect(r.markdown).not.toContain('secrets');
    expect(r.markdown).not.toContain('/etc/passwd');
    expect(blocks(r.markdown)[0]).toContain('`src/ledger/posting.py`');
  });

  test('verified_by lists only existing test files; commands and ghosts are dropped', () => {
    const r = ok();
    const fm = frontmatter(r.markdown);
    expect(fm.verified_by).toBe('[tests/test_posting.py]');
    expect(r.dropped.verification.sort()).toEqual(['run pytest', 'tests/test_ghost.py']);
  });

  test('no real test path: verified_by and assertions are omitted entirely', () => {
    const r = ok({ answers: answers({ verification: ['run pytest', 'tests/test_ghost.py'] }) });
    expect(r.markdown).not.toContain('verified_by');
    expect(r.markdown).not.toContain('assertions');
  });

  test('a non-test file named as verification is not claimed', () => {
    const r = ok({ answers: answers({ verification: ['src/ledger/posting.py'] }) });
    expect(r.markdown).not.toContain('verified_by');
  });

  test('assertions only for a verifiably present test file', () => {
    const md = ok().markdown;
    expect(md).toContain('assertions:');
    expect(md).toContain('type: "test_file"');
    expect(md).toContain('path: "tests/test_posting.py"');
    expect(md).not.toMatch(/type: "(symbol|route|migration|config_key|symbol_reachable)"/);
  });

  test('an unreadable tree (files null) claims no path at all', () => {
    const r = ok({ files: null });
    expect(r.markdown).not.toContain('verified_by');
    expect(r.markdown).not.toContain('`src/ledger/posting.py`');
    expect(r.warnings.join(' ')).toMatch(/could not be read|unreadable/i);
  });

  test('surfaces lists existing files only, up to four, most important first', () => {
    expect(frontmatter(ok().markdown).surfaces).toBe('[src/ledger/posting.py]');
  });
});

describe('authorSpec: format resolution', () => {
  const MIRROR = `---
title: Existing Thing
status: active
owner: someone
summary: The thing MUST exist.
domain: platform
verified_by: [tests/test_posting.py]
---
# Existing Thing

## Do the thing

### Capability statement

The thing MUST do the thing.

### Invariants

- the thing is a thing

### Acceptance criteria

- AC-1: WHEN x THEN y

### Code surface

- \`src/x.py\`

### Out of scope

- nothing
`;

  test('no existing spec: the default format (bold labels)', () => {
    const r = ok();
    expect(r.format).toBe('default');
    expect(r.markdown).toContain('**Acceptance criteria**:');
  });

  test('an existing spec in the root is mirrored: heading-style sections', () => {
    const r = ok({ specsRoot: 'docs/specs', mirrorSpecs: [MIRROR] });
    expect(r.format).toBe('mirrored');
    const [first] = blocks(r.markdown);
    expect(first).toContain('### Capability statement');
    expect(first).toContain('### Acceptance criteria');
    expect(first).not.toContain('**Invariants**');
    expect(first.match(/^- AC-\d+: /gm)!.length).toBeGreaterThanOrEqual(3);
  });

  test('a mirrored spec still carries every required default field and status draft', () => {
    const fm = frontmatter(ok({ specsRoot: 'docs/specs', mirrorSpecs: [MIRROR] }).markdown);
    for (const k of ['title', 'status', 'owner', 'last_verified', 'summary', 'domain']) expect(fm[k], k).toBeTruthy();
    expect(fm.status).toBe('draft');
  });

  test('a mirror with no frontmatter falls back to the default', () => {
    expect(ok({ specsRoot: 'docs/specs', mirrorSpecs: ['# just prose\n'] }).format).toBe('default');
  });

  test('the domain comes from the answers, else a default that is flagged', () => {
    expect(frontmatter(ok({ answers: answers({ domain: 'Billing' }) }).markdown).domain).toBe('billing');
    const r = ok();
    expect(frontmatter(r.markdown).domain).toBe('product');
    expect(r.warnings.join(' ')).toMatch(/domain/i);
  });
});

describe('authorSpec: validation and Q8', () => {
  test('invalid answers are rejected with the paths to re-ask', () => {
    const bad = answers();
    bad.capabilities[0].invariants = ['works properly'];
    const r = authorSpec({ ...base, answers: bad });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.path)).toContain('capabilities[0].invariants[0]');
  });

  test('Q8 never appears in the spec; it is returned for the merge-policy decision', () => {
    const r = ok();
    expect(r.markdown).not.toContain('audit log format');
    expect(r.mergePolicy.paths).toEqual(['src/ledger/posting.py']);
    expect(r.mergePolicy.notes).toEqual(['the audit log format']);
  });

  test('is deterministic', () => {
    expect(ok().markdown).toBe(ok().markdown);
  });
});

describe('buildAuthorSpecTaskDescription', () => {
  test('asks for exactly one file on a task branch, never the default branch', () => {
    const r = ok();
    const d = buildAuthorSpecTaskDescription({ path: r.path, markdown: r.markdown, defaultBranch: 'trunk' });
    expect(d).toContain('`docs/specs/ledger.md`');
    expect(d).toContain('Never commit or push to the default branch `trunk`');
    expect(d).toContain('exactly one file');
    expect(d).toContain('status: draft');
    expect(d).toContain(r.markdown.replace(/\n$/, ''));
  });
});
