import { describe, it, expect } from 'bun:test';
import {
  buildTaskCard,
  buildSessionCard,
  buildPrCard,
  buildArtifactCard,
  buildPlanCard,
  renderPlanText,
  truncate,
  CARD_CONTENT_CAP,
} from '../knowledge-store/cards';
import { VoyageEmbedder } from '../knowledge-store/voyage-embedder';

// ── truncate ─────────────────────────────────────────────────────────────────

describe('truncate', () => {
  it('leaves short content untouched', () => {
    expect(truncate('hello')).toBe('hello');
  });

  it('caps very large content', () => {
    const big = 'x'.repeat(CARD_CONTENT_CAP + 500);
    const out = truncate(big);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain('truncated');
    expect(out.startsWith('x'.repeat(CARD_CONTENT_CAP))).toBe(true);
  });
});

// ── buildTaskCard (corpus task, phase outcome) ───────────────────────────────

describe('buildTaskCard', () => {
  it('builds a stable sourceId, outcome phase, linkage, and synthesized card', () => {
    const chunk = buildTaskCard({
      taskId: 't-1',
      title: 'Fix login bug',
      description: 'Users cannot log in via SSO',
      summary: 'Patched the SSO callback handler',
      success: true,
      prUrl: 'https://github.com/o/r/pull/42',
      missionId: 'm-9',
    });

    expect(chunk.id).toBe('task:t-1');
    expect(chunk.sourceType).toBe('task');
    expect(chunk.metadata?.phase).toBe('outcome');
    expect(chunk.metadata?.taskId).toBe('t-1');
    expect(chunk.metadata?.missionId).toBe('m-9');
    expect(chunk.metadata?.success).toBe(true);
    // Card is synthesized text, not a raw dump
    expect(chunk.content).toContain('Fix login bug');
    expect(chunk.content).toContain('Users cannot log in via SSO');
    expect(chunk.content).toContain('Patched the SSO callback handler');
    expect(chunk.content).toContain('SUCCESS');
    expect(chunk.content).toContain('https://github.com/o/r/pull/42');
    expect(chunk.sourceUrl).toBe('/app/tasks/t-1');
  });

  it('marks failed tasks and omits missionId when absent', () => {
    const chunk = buildTaskCard({
      taskId: 't-2',
      title: 'Broken build',
      success: false,
    });
    expect(chunk.content).toContain('FAILED');
    expect(chunk.metadata?.success).toBe(false);
    expect(chunk.metadata?.missionId).toBeUndefined();
  });
});

// ── buildSessionCard (corpus session, phase session) ─────────────────────────

describe('buildSessionCard', () => {
  it('builds a stable session:{taskId} id, session phase, and process narrative', () => {
    const chunk = buildSessionCard({
      taskId: 't-1',
      workerId: 'w-5',
      title: 'Fix login bug',
      summary: 'Tried patching the callback; root cause was a stale token',
      nextSuggestion: 'Add a regression test for expired tokens',
      success: true,
      turns: 12,
      missionId: 'm-9',
    });

    expect(chunk.id).toBe('session:t-1');
    expect(chunk.sourceType).toBe('session');
    expect(chunk.metadata?.phase).toBe('session');
    expect(chunk.metadata?.taskId).toBe('t-1');
    expect(chunk.metadata?.workerId).toBe('w-5');
    expect(chunk.metadata?.missionId).toBe('m-9');
    expect(chunk.metadata?.success).toBe(true);
    expect(chunk.content).toContain('Fix login bug');
    expect(chunk.content).toContain('completed');
    expect(chunk.content).toContain('12 turns');
    expect(chunk.content).toContain('stale token');
    expect(chunk.content).toContain('regression test for expired tokens');
    expect(chunk.sourceUrl).toBe('/app/tasks/t-1');
  });

  it('marks failed/aborted sessions and omits optional linkage/effort when absent', () => {
    const chunk = buildSessionCard({
      taskId: 't-2',
      success: false,
    });
    expect(chunk.id).toBe('session:t-2');
    expect(chunk.content).toContain('failed/aborted');
    expect(chunk.content).not.toContain('turns');
    expect(chunk.metadata?.success).toBe(false);
    expect(chunk.metadata?.workerId).toBeUndefined();
    expect(chunk.metadata?.missionId).toBeUndefined();
  });

  it('keys by taskId so a re-worked task upserts to its latest session', () => {
    const a = buildSessionCard({ taskId: 't-9', workerId: 'w-1', success: true });
    const b = buildSessionCard({ taskId: 't-9', workerId: 'w-2', success: true });
    expect(a.id).toBe(b.id);
    expect(a.id).toBe('session:t-9');
  });
});

// ── buildPrCard (corpus pr, phase implementation) ────────────────────────────

describe('buildPrCard', () => {
  it('builds a pr:{number} sourceId with implementation phase and changed files', () => {
    const chunk = buildPrCard({
      prNumber: 42,
      title: 'feat: add SSO',
      body: 'Adds SSO support via OIDC',
      url: 'https://github.com/o/r/pull/42',
      changedFiles: ['src/auth.ts', 'src/sso.ts'],
      taskId: 't-1',
      missionId: 'm-9',
    });

    expect(chunk.id).toBe('pr:42');
    expect(chunk.sourceType).toBe('pr');
    expect(chunk.metadata?.phase).toBe('implementation');
    expect(chunk.metadata?.prNumber).toBe(42);
    expect(chunk.metadata?.taskId).toBe('t-1');
    expect(chunk.metadata?.missionId).toBe('m-9');
    expect(chunk.content).toContain('feat: add SSO');
    expect(chunk.content).toContain('Adds SSO support via OIDC');
    expect(chunk.content).toContain('src/auth.ts');
    expect(chunk.sourceUrl).toBe('https://github.com/o/r/pull/42');
  });
});

// ── buildArtifactCard (corpus artifact) ──────────────────────────────────────

describe('buildArtifactCard', () => {
  it('builds an artifact:{id} sourceId with title + content and truncates large content', () => {
    const big = 'y'.repeat(CARD_CONTENT_CAP + 1000);
    const chunk = buildArtifactCard({
      artifactId: 'a-7',
      title: 'Research summary',
      artifactType: 'summary',
      content: big,
      shareUrl: 'https://buildd.dev/s/a-7',
      taskId: 't-1',
    });

    expect(chunk.id).toBe('artifact:a-7');
    expect(chunk.sourceType).toBe('artifact');
    expect(chunk.metadata?.artifactId).toBe('a-7');
    expect(chunk.metadata?.artifactType).toBe('summary');
    expect(chunk.metadata?.taskId).toBe('t-1');
    expect(chunk.content).toContain('Research summary');
    expect(chunk.content).toContain('truncated');
    expect(chunk.content.length).toBeLessThan(big.length);
    expect(chunk.sourceUrl).toBe('https://buildd.dev/s/a-7');
  });
});

// ── buildPlanCard (corpus plan, phase plan) ──────────────────────────────────

describe('renderPlanText', () => {
  it('renders structured plan steps to concise markdown', () => {
    const text = renderPlanText([
      { ref: 'A', title: 'Build API', description: 'Add endpoints' },
      { ref: 'B', title: 'Wire UI', dependsOn: ['A'] },
    ]);
    expect(text).toContain('A: Build API');
    expect(text).toContain('Add endpoints');
    expect(text).toContain('B: Wire UI');
    expect(text).toContain('depends on: A');
  });

  it('returns null for empty / non-array input', () => {
    expect(renderPlanText([])).toBeNull();
    expect(renderPlanText(undefined)).toBeNull();
    expect(renderPlanText('not a plan')).toBeNull();
  });
});

describe('buildPlanCard', () => {
  it('builds a plan:{taskId} sourceId with plan phase', () => {
    const chunk = buildPlanCard({
      taskId: 't-1',
      title: 'Build SSO',
      plan: '1. Build API\n2. Wire UI',
      missionId: 'm-9',
    });

    expect(chunk.id).toBe('plan:t-1');
    expect(chunk.sourceType).toBe('plan');
    expect(chunk.metadata?.phase).toBe('plan');
    expect(chunk.metadata?.taskId).toBe('t-1');
    expect(chunk.metadata?.missionId).toBe('m-9');
    expect(chunk.content).toContain('Build SSO');
    expect(chunk.content).toContain('Build API');
    expect(chunk.sourceUrl).toBe('/app/tasks/t-1');
  });
});

// ── VoyageEmbedder input_type plumbing ───────────────────────────────────────

describe('VoyageEmbedder input_type', () => {
  const origFetch = globalThis.fetch;

  function stubFetch(): { body: () => any } {
    let captured: any = null;
    globalThis.fetch = (async (_url: string, init: any) => {
      captured = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          data: [{ embedding: [0, 0, 0, 0], index: 0 }],
          model: 'voyage-4-large',
          usage: { total_tokens: 1 },
        }),
      } as any;
    }) as any;
    return { body: () => captured };
  }

  it('defaults to voyage-4-large and input_type=document', async () => {
    const cap = stubFetch();
    try {
      const e = new VoyageEmbedder('test-key');
      expect(e.model).toBe('voyage-4-large');
      await e.embed(['hello']);
      expect(cap.body().model).toBe('voyage-4-large');
      expect(cap.body().input_type).toBe('document');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('passes input_type=query when requested', async () => {
    const cap = stubFetch();
    try {
      const e = new VoyageEmbedder('test-key');
      await e.embed(['search me'], 'query');
      expect(cap.body().input_type).toBe('query');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
