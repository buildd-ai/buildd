import { describe, expect, it } from 'bun:test';
import { parseCopyReviewConfig, copyReviewConfigOf } from '@buildd/shared';
import {
  applyCopyReviewGate,
  changedCopyStrings,
  parseCopyFindings,
  renderCopyReviewSection,
} from './copy-review';
import { REVIEWER_TASK_OUTPUT_SCHEMA } from './reviewer';

const CONFIG = { voiceGuide: 'docs/design/design-system.md', lintCommand: 'bun run copy:check', mode: 'gate' as const };

// A real slop line from Settings > Models, as an added hunk.
const MODELS_PATCH = [
  '@@ -10,6 +10,9 @@ export function ClaudeSubscriptionCard() {',
  '   return (',
  '     <div className="flex flex-col gap-2">',
  '-      <p>Used for claude runs</p>',
  '+      <p className="text-muted">Not chat: A subscription seat signs in a runner; the server never spends a seat.</p>',
  '+      <p>All set!</p>',
  "+      <Button variant=\"ghost\" onClick={() => router.push('/app/settings/models')}>Replace</Button>",
  '     </div>',
  '   );',
  ' }',
].join('\n');

const files = [
  { filename: 'apps/web/src/components/settings/ClaudeSubscriptionCard.tsx', status: 'modified', additions: 3, deletions: 1, patch: MODELS_PATCH },
  { filename: 'apps/web/src/app/api/models/route.ts', status: 'modified', additions: 1, deletions: 0, patch: "@@ -1,1 +1,2 @@\n+const msg = 'This is an API error message, not UI copy at all';" },
];

describe('copy review config', () => {
  it('is off unless the workspace sets it', async () => {
    expect(copyReviewConfigOf(undefined)).toBeNull();
    expect(copyReviewConfigOf({})).toBeNull();
    expect(copyReviewConfigOf({ copyReview: null })).toBeNull();
  });

  it('accepts review and gate, and needs a voice guide', async () => {
    expect(parseCopyReviewConfig(CONFIG)).toEqual({ ok: true, config: CONFIG });
    expect(parseCopyReviewConfig({ voiceGuide: 'VOICE.md', mode: 'review' }).ok).toBe(true);
    expect(parseCopyReviewConfig({ mode: 'gate' }).ok).toBe(false);
    expect(parseCopyReviewConfig({ voiceGuide: 'VOICE.md', mode: 'loud' }).ok).toBe(false);
    expect(parseCopyReviewConfig({ voiceGuide: 'VOICE.md', mode: 'gate', extra: 1 }).ok).toBe(false);
  });

  it('a malformed stored config reads as off, never as gate', async () => {
    expect(copyReviewConfigOf({ copyReview: { mode: 'gate' } })).toBeNull();
  });
});

describe('changedCopyStrings', () => {
  it('returns only the strings a PR adds to a UI file', async () => {
    const strings = await changedCopyStrings(files, CONFIG);
    const texts = strings.map((s) => s.text);
    expect(texts).toContain('Not chat: A subscription seat signs in a runner; the server never spends a seat.');
    expect(texts).toContain('All set!');
    expect(texts).toContain('Replace');
    // removed lines, class lists, routes and non-UI files never count
    expect(texts).not.toContain('Used for claude runs');
    expect(texts.some((t) => t.includes('text-muted') || t.includes('/app/settings'))).toBe(false);
    expect(strings.every((s) => !s.path.includes('/api/'))).toBe(true);
  });

  it('carries the new-side line number of each string', async () => {
    const s = (await changedCopyStrings(files, CONFIG)).find((x) => x.text === 'All set!');
    expect(s?.line).toBe(13);
  });

  it('honours the workspace paths when set', async () => {
    expect(await changedCopyStrings(files, { ...CONFIG, paths: ['src/ui/**'] })).toEqual([]);
  });

  it('flags the strings the copy rules already catch', async () => {
    const s = (await changedCopyStrings(files, CONFIG)).find((x) => x.text === 'All set!');
    expect(s?.ruleHits.length).toBeGreaterThan(0);
  });
});

describe('renderCopyReviewSection', () => {
  it('names the voice guide, the lint command and every changed string', async () => {
    const strings = await changedCopyStrings(files, CONFIG);
    const section = renderCopyReviewSection({ config: CONFIG, strings, instructions: '# Copy Editor\nLabels are nouns.' });
    expect(section).toContain('docs/design/design-system.md');
    expect(section).toContain('bun run copy:check');
    expect(section).toContain('All set!');
    expect(section).toContain('copyFindings');
    expect(section).toContain('Labels are nouns.');
  });

  it('is empty when the PR changes no copy', async () => {
    expect(renderCopyReviewSection({ config: CONFIG, strings: [], instructions: '' })).toBe('');
  });
});

describe('reviewer output schema', () => {
  it('accepts copyFindings', async () => {
    expect((REVIEWER_TASK_OUTPUT_SCHEMA.properties as Record<string, unknown>).copyFindings).toBeDefined();
  });
});

describe('applyCopyReviewGate', () => {
  const findings = parseCopyFindings([
    { path: 'a.tsx', line: 13, text: 'Not chat: A subscription seat signs in a runner.', verdict: 'rewrite', rewrite: 'Used by Claude agents on your runners.', reason: 'not-this-its-that' },
    { path: 'a.tsx', line: 15, text: 'Replace', verdict: 'ok' },
  ]);

  it('gate: an approval with copy to rewrite becomes request-changes with the rewrites', async () => {
    const r = applyCopyReviewGate({ verdict: 'approve', mode: 'gate', findings, feedback: undefined });
    expect(r.verdict).toBe('request-changes');
    expect(r.feedback).toContain('Used by Claude agents on your runners.');
    expect(r.feedback).toContain('a.tsx:13');
    expect(r.reason).toContain('copy');
  });

  it('gate: request-changes keeps its verdict and gains the rewrites', async () => {
    const r = applyCopyReviewGate({ verdict: 'request-changes', mode: 'gate', findings, feedback: 'Fix the test.' });
    expect(r.verdict).toBe('request-changes');
    expect(r.feedback).toContain('Fix the test.');
    expect(r.feedback).toContain('Used by Claude agents on your runners.');
  });

  it('gate: escalate stays escalate', async () => {
    expect(applyCopyReviewGate({ verdict: 'escalate', mode: 'gate', findings, feedback: undefined }).verdict).toBe('escalate');
  });

  it('gate: nothing to rewrite changes nothing', async () => {
    const ok = parseCopyFindings([{ path: 'a.tsx', text: 'Replace', verdict: 'ok' }]);
    const r = applyCopyReviewGate({ verdict: 'approve', mode: 'gate', findings: ok, feedback: undefined });
    expect(r).toEqual({ verdict: 'approve', feedback: undefined, reason: null, note: null });
  });

  it('review: never blocks, and returns a note for the PR', async () => {
    const r = applyCopyReviewGate({ verdict: 'approve', mode: 'review', findings, feedback: undefined });
    expect(r.verdict).toBe('approve');
    expect(r.reason).toBeNull();
    expect(r.note).toContain('Used by Claude agents on your runners.');
  });

  it('off: no config, no change', async () => {
    const r = applyCopyReviewGate({ verdict: 'approve', mode: null, findings, feedback: undefined });
    expect(r).toEqual({ verdict: 'approve', feedback: undefined, reason: null, note: null });
  });

  it('drops malformed findings instead of trusting them', async () => {
    expect(parseCopyFindings([{ verdict: 'rewrite' }, 'x', null])).toEqual([]);
    expect(parseCopyFindings('nope')).toEqual([]);
  });
});
