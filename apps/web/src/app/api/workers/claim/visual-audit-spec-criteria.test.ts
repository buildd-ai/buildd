import { describe, expect, it, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: { query: { tasks: { findMany: mock(() => Promise.resolve([])) } } } }));

const { attachVisualAuditSpecCriteria, renderVisualAuditSpecCriteria, VISUAL_AUDIT_SPEC_CRITERIA_CONTEXT_KEY } = await import('./visual-audit-spec-criteria');

const worker = (taskId: string) => ({ taskId, task: { id: taskId, context: {} } }) as any;
const BUILDER = '11111111-1111-4111-8111-111111111111';
const subject = (criteria: Array<{ id: string; text: string }>) => ({ taskId: BUILDER, taskTitle: 'feat(cart): empty state', specTitle: 'Cart', revision: 3, criteria });

describe('renderVisualAuditSpecCriteria', () => {
  it('names each task, its spec revision and the criteria it answers for, and how to record a verdict', () => {
    const block = renderVisualAuditSpecCriteria([subject([{ id: 'AC-1', text: 'An empty cart shows the empty state.' }])])!;
    expect(block).toContain('## Spec criteria to judge (computed at claim)');
    expect(block).toContain(`taskId \`${BUILDER}\`, spec "Cart" revision 3`);
    expect(block).toContain('- **AC-1** An empty cart shows the empty state.');
    expect(block).toContain('checker: "visual"');
    expect(block).toContain('capturedSha');
    expect(block).toContain('not pixels');
    expect(block).toContain('Skip a criterion nothing on screen can show');
  });

  it('names the pinned design, how to open it, and the screens each criterion covers', () => {
    const block = renderVisualAuditSpecCriteria([{
      ...subject([{ id: 'AC-1', text: 'Empty state.', screens: ['cart-empty'] }, { id: 'AC-2', text: 'Totals.' }]),
      design: { kind: 'artifact', ref: 'art-1', version: '4', screens: [{ id: 'cart-empty', name: 'Empty cart' }] },
    }])!;
    expect(block).toContain('Design: artifact at version 4, open with get_artifact { artifactId: "art-1", revision: 4 }; screens cart-empty (Empty cart)');
    expect(block).toContain('- **AC-1** Empty state. (screens: cart-empty)');
    expect(block).toContain('- **AC-2** Totals.\n\n### Design vs built');
    expect(block).toContain('designShotIds');
  });

  it('gives the auditor a design plan for design vs built: the screens each criterion names, at the pinned revision', () => {
    const block = renderVisualAuditSpecCriteria([{
      ...subject([{ id: 'AC-4', text: 'The mission page.', screens: ['phone-mission', 'desktop-mission'] }, { id: 'AC-1', text: 'Links.' }]),
      design: { kind: 'artifact', ref: 'art-1', version: '1', screens: [] },
    }])!;
    expect(block).toContain('### Design vs built');
    expect(block).toContain('scripts/qa/design-capture.ts');
    expect(block).toContain('"design":{"artifactId":"art-1","revision":1,"file":"<the downloaded file>"}');
    expect(block).toContain('"criteria":[{"id":"AC-4","text":"The mission page.","screens":["phone-mission","desktop-mission"]}]');
    expect(block).toContain('side-by-side/');
  });

  it("the mission's design_reference wins over the spec's pin", () => {
    const block = renderVisualAuditSpecCriteria([{
      ...subject([{ id: 'AC-4', text: 'The mission page.', screens: ['phone-mission'] }]),
      design: { kind: 'artifact', ref: 'spec-art', version: '1', screens: [] },
    }], { artifactId: 'mission-art', revision: 3 })!;
    expect(block).toContain('Design: the mission\'s design_reference, artifact mission-art at revision 3');
    expect(block).toContain('"artifactId":"mission-art","revision":3');
    expect(block).not.toContain('"artifactId":"spec-art"');
  });

  it('renders nothing when no dependency is pinned, or none has criteria', () => {
    expect(renderVisualAuditSpecCriteria([])).toBeNull();
    expect(renderVisualAuditSpecCriteria([subject([])])).toBeNull();
  });
});

describe('attachVisualAuditSpecCriteria', () => {
  it('attaches the block and the criteria ids to a visual audit, from its current dependencies', async () => {
    const seen: string[][] = [];
    const cw = worker('audit-1');
    await attachVisualAuditSpecCriteria([cw], [{ id: 'audit-1', roleSlug: 'visual-auditor', dependsOn: [BUILDER] }], async (deps) => {
      seen.push([...deps]);
      return [subject([{ id: 'AC-1', text: 'x' }, { id: 'AC-2', text: 'y' }])];
    });
    expect(seen).toEqual([[BUILDER]]);
    expect(cw.task.context[VISUAL_AUDIT_SPEC_CRITERIA_CONTEXT_KEY]).toEqual([{ taskId: BUILDER, revision: 3, criteria: ['AC-1', 'AC-2'] }]);
    expect(cw.resolvedContextProviders).toHaveLength(1);
  });

  it("reads the audit's mission design_reference and names it in the block", async () => {
    const cw = worker('audit-3');
    const asked: string[] = [];
    await attachVisualAuditSpecCriteria([cw], [{ id: 'audit-3', roleSlug: 'visual-auditor', dependsOn: [BUILDER], missionId: 'm-1' }],
      async () => [subject([{ id: 'AC-4', text: 'x', screens: ['phone-mission'] }])],
      async (missionId) => { asked.push(missionId); return { artifactId: 'mission-art', revision: 2 }; });
    expect(asked).toEqual(['m-1']);
    expect(cw.task.context[VISUAL_AUDIT_SPEC_CRITERIA_CONTEXT_KEY]).toEqual([{ taskId: BUILDER, revision: 3, criteria: ['AC-4'] }]);
    expect(cw.task.context.visualAuditDesign).toEqual({ artifactId: 'mission-art', revision: 2, from: 'mission' });
  });

  it('leaves other roles alone, and a failing read attaches nothing', async () => {
    const builder = worker('b-1');
    let calls = 0;
    await attachVisualAuditSpecCriteria([builder], [{ id: 'b-1', roleSlug: 'builder', dependsOn: [] }], async () => { calls++; return []; });
    expect(calls).toBe(0);
    const audit = worker('audit-2');
    await attachVisualAuditSpecCriteria([audit], [{ id: 'audit-2', roleSlug: 'visual-auditor', dependsOn: [BUILDER] }], async () => { throw new Error('db down'); });
    expect(audit.task.context[VISUAL_AUDIT_SPEC_CRITERIA_CONTEXT_KEY]).toBeUndefined();
    expect(audit.resolvedContextProviders).toBeUndefined();
  });
});
