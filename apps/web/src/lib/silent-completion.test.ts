import { describe, expect, it } from 'bun:test';
import { isSilentCompletion, silentCompletionRetryContext } from './silent-completion';

const empty = { status: 'completed', outputRequirement: 'auto', kind: 'writing', summarySource: 'agent', summary: "Checking the code.\n\n---\n\nNow locating the document.", commitCount: 0, filesChanged: 0, dirtyWorktree: false };
describe('silent completion', () => {
  it('rejects an agent-tagged fallback tail', () => expect(isSilentCompletion(empty)).toBe(true));
  it.each(['analysis', 'research'])('accepts a %s outcome without edits', kind => expect(isSilentCompletion({ ...empty, kind })).toBe(false));
  it('accepts a real editing outcome without edits', () => expect(isSilentCompletion({ ...empty, summary: 'Verified the behavior; no change was needed.' })).toBe(false));
  it.each(['artifact_required', 'none'])('leaves %s alone', outputRequirement => expect(isSilentCompletion({ ...empty, outputRequirement })).toBe(false));
  it.each([{ discardEdits: 'Scratch work.' }, { hasPR: true }, { hasArtifact: true }, { mergedAt: new Date() }, { observedTouches: ['docs/spec.md'] }, { commitCount: 1 }, { filesChanged: 1 }, { dirtyWorktree: true }, { isReviewer: true }, { taskClass: 'bookkeeping' }])('accepts evidence or exemption %j', evidence => expect(isSilentCompletion({ ...empty, ...evidence })).toBe(false));
  it.each(['I’ll inspect the code.', 'Now let me read the file.', 'The change is', ''])('rejects narration or fragments %s', summary => expect(isSilentCompletion({ ...empty, summary })).toBe(true));
  it('accepts narration following an outcome sentence', () => expect(isSilentCompletion({ ...empty, summary: "Fixed the defect. I'll check CI." })).toBe(false));
  it('fallback provenance refuses even a punctuated outcome', () => expect(isSilentCompletion({ ...empty, summarySource: 'fallback', summary: 'Fixed the defect.' })).toBe(true));
  it('a concrete manifest brings analysis within the gate', () => expect(isSilentCompletion({ ...empty, kind: 'analysis', pathManifest: ['docs/spec.md'] })).toBe(true));
  it('requeues once and marks prior prose unauthored', () => {
    const first = silentCompletionRetryContext({ custom: true, forceClaim: { bypassed: [] } });
    expect(first.retry).toBe(true);
    expect(first.context).not.toHaveProperty('forceClaim');
    expect(first.context.silentCompletionRetryCount).toBe(1);
    expect(first.context.failureContext.summarySource).toBe('fallback');
    expect(silentCompletionRetryContext(first.context).retry).toBe(false);
  });
});
