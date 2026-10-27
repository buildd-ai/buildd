/**
 * Acceptance checks for Living Spec f43b6a61 "Designs in buildd", revision 1.
 * Each check is listed in the spec's metadata `verified_by`, keyed by its id.
 *
 * They assert against the modules that carry the behaviour:
 *   lib/designs/{screens,store,prompt}.ts   screen list, store plan, builder prompt
 *   lib/design-preview.ts                   fitScale, designPreviewHref, frameSrc, screen sizes
 *   components/DesignPreview.tsx            the sandboxed, labelled frame
 *   scripts/design/export-canvas.ts         canvas -> design (screens, links, source)
 *   api/workers/claim/visual-audit-spec-criteria.ts   the design-vs-built visual check
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import DesignPreview from '../../src/components/DesignPreview';
import { designPreviewHref, fitScale, frameSrc, resolveDesignScreens } from '../../src/lib/design-preview';
import { exportCanvas } from '../../../../scripts/design/export-canvas';
import { renderVisualAuditSpecCriteria, type SubjectCriteria } from '../../src/app/api/workers/claim/visual-audit-spec-criteria';

const SRC = join(import.meta.dir, '..', '..', 'src');
const DESIGNS = join(SRC, 'lib', 'designs');

/** Load a seam module; a missing one fails with a short message. */
async function seam(name: string): Promise<any> {
  const file = ['.ts', '.tsx'].map(e => join(DESIGNS, name + e)).find(existsSync);
  if (!file) throw new Error(`src/lib/designs/${name}.ts does not exist yet`);
  return import(file);
}

/** The files that draw a design frame. */
const FRAME_FILES = [
  join(SRC, 'components', 'DesignPreview.tsx'),
  join(SRC, 'components', 'design-stage.tsx'),
  join(SRC, 'components', 'DesignsSection.tsx'),
];

const STORAGE = 'https://files.example.test/d.html?X-Amz-Signature=sig';
const frame = (revision: number, title: string, src = STORAGE) =>
  renderToStaticMarkup(
    createElement(DesignPreview, {
      artifactId: 'D',
      title,
      revision,
      frameUrl: src,
      screens: resolveDesignScreens({ screens: SCREENS }, null),
      downloadUrl: '/api/artifacts/D/download',
      fileName: 'd.html',
      sizeLabel: '1 KB',
    }),
  );
const iframeTag = (html: string) => /<iframe\b[^>]*>/.exec(html)![0];

/** A two-board canvas with one link between the boards, as Claude Design writes it. */
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function twoBoardCanvas(): string {
  const root = mkdtempSync(join(tmpdir(), 'canvas-'));
  dirs.push(root);
  const project = join(root, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'canvas.json'), JSON.stringify({
    boards: [
      { file: 'A.dc.html', title: 'A', x: 0, y: 0, width: 390, height: 844 },
      { file: 'B.dc.html', title: 'B', x: 500, y: 0, width: 390, height: 844 },
    ],
  }));
  const board = (title: string, link: string) => `<!doctype html><html><head><title>${title}</title></head><body><x-dc><helmet><style>body{margin:0}</style></helmet><div style="width: 390px"><a href="${link}">go</a></div></x-dc><script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":390,"height":844}}'>class Component extends DCLogic { renderVals() { return {}; } }</script></body></html>`;
  writeFileSync(join(project, 'A.dc.html'), board('A', 'B.dc.html'));
  writeFileSync(join(project, 'B.dc.html'), board('B', 'A.dc.html'));
  return project;
}

const SCREENS = [
  { id: 'desktop-mission', name: 'Mission', viewport: '1440x900' },
  { id: 'phone-mission', name: 'Mission (phone)', viewport: '390x844' },
  { id: 'desktop-task', name: 'Task', viewport: '1440x900' },
];
const CRITERION = { id: 'AC-8', screens: ['desktop-mission'] };
const SUBJECT: SubjectCriteria = {
  taskId: 't1', taskTitle: 'Build the mission page', specTitle: 'Spec', revision: 1,
  design: { kind: 'artifact', ref: 'D', version: '1', screens: SCREENS.map(({ id, name }) => ({ id, name })) },
  criteria: [{ id: 'AC-8', text: 'The mission page matches the design', screens: ['desktop-mission'] }],
};
/** The visual auditor's prompt block for one criterion that names a design screen. */
const visualPrompt = () => renderVisualAuditSpecCriteria([SUBJECT], null, []) ?? '';

describe('store and attach', () => {
  it('R-1: a design is stored without a worker, claim or inline body', async () => {
    const { planStore } = await seam('store');
    const plan = planStore({ screens: SCREENS, attachTo: { kind: 'mission', id: 'm1' } });
    expect(plan.revision).toBe(1);
    const mcpDir = join(SRC, 'app/api/mcp');
    const text = readdirSync(mcpDir, { recursive: true }).map(f => (String(f).endsWith('.ts') ? readFileSync(join(mcpDir, String(f)), 'utf8') : '')).join('\n');
    expect(text).toMatch(/store_design|create_design/);
  });

  it('R-2: a screen list is parsed, and a malformed one names the field', async () => {
    const { parseScreens } = await seam('screens');
    expect(parseScreens(SCREENS)).toMatchObject({ ok: true });
    expect(parseScreens([{ id: 'a', name: 'A' }])).toMatchObject({ ok: false, field: 'viewport' });
  });

  it('R-3: a new export is the next revision of the same design', async () => {
    const { planStore } = await seam('store');
    expect(planStore({ existing: { id: 'D', currentRevision: 1 }, screens: SCREENS })).toMatchObject({ id: 'D', revision: 2 });
  });

  it('R-4: storing and attaching is one step, to a mission, task or spec revision', async () => {
    const { planStore } = await seam('store');
    for (const kind of ['mission', 'task', 'spec'] as const) {
      expect(planStore({ screens: SCREENS, attachTo: { kind, id: 'x' } }).attachedTo).toEqual({ kind, id: 'x' });
    }
  });

  it('R-5: a canvas becomes a design keeping its address as source', () => {
    const out = exportCanvas(twoBoardCanvas(), { source: 'https://claude.ai/design/abc' });
    expect(out.metadata.kind).toBe('design');
    expect(out.metadata.source).toBe('https://claude.ai/design/abc');
  });
});

describe('view', () => {
  it('R-6: a screen is scaled to the column with a 100% option', () => {
    expect(fitScale(1440, 360)).toBeCloseTo(360 / 1440, 3);
    expect(fitScale(390, 800)).toBe(1); // never enlarged
    const html = frame(1, 'T');
    expect(html).toMatch(/100\s?%/);
  });

  it('R-7: a link opens one screen of one revision', () => {
    const href = designPreviewHref('D', { screen: 'desktop-mission', revision: 1 });
    expect(href).toContain('/app/artifacts/D');
    expect(href).toContain('screen=desktop-mission');
    expect(href).toContain('revision=1');
    expect(frameSrc('https://s.test/x.html', 'desktop-mission')).toBe('https://s.test/x.html#desktop-mission');
  });

  it('R-8: a design runs in a script-only sandbox on the storage origin', () => {
    const tag = iframeTag(frame(2, 'T'));
    expect(/sandbox="([^"]*)"/.exec(tag)![1].split(/\s+/)).toEqual(['allow-scripts']);
    expect(tag).toContain('src="https://files.example.test/d.html');
    expect(/aria-label="([^"]*)"/.exec(tag)![1]).toMatch(/design preview/i);
    expect(tag).toMatch(/revision 2/);
  });

  it('R-9: the frame uses design-system tokens, not literal colours', () => {
    for (const f of FRAME_FILES) {
      expect(existsSync(f)).toBe(true);
      expect(readFileSync(f, 'utf8')).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
    }
  });
});

describe('build and verify', () => {
  it('R-10: a builder gets the task design, else mission, else spec, naming criterion screens', async () => {
    const { designPromptSection } = await seam('prompt');
    const text = designPromptSection({
      missionDesign: { id: 'MISSION-D', revision: 1 },
      specDesign: { id: 'SPEC-D', revision: 3 },
      criteria: [{ id: 'AC-1', screens: ['desktop-mission'] }],
    });
    expect(text).toContain('MISSION-D');
    expect(text).not.toContain('SPEC-D');
    expect(text).toContain('desktop-mission');
  });

  it('R-11: the visual check renders each criterion screen beside the built page', () => {
    const text = visualPrompt();
    expect(text).toContain('### Design vs built');
    expect(text).toContain('"screens":["desktop-mission"]');
    expect(text).toContain('side-by-side/<shot>--<screen>.png (design | built)');
  });

  it('R-12: both images are kept as evidence and the design screen can be opened', () => {
    const text = visualPrompt();
    expect(text).toContain('Upload the side-by-side image and the design shot');
    expect(text).toContain('designShotIds');
    expect(designPreviewHref('D', { screen: 'desktop-mission', revision: 1 })).toContain('screen=desktop-mission');
  });
});

describe('acceptance criteria', () => {
  it('AC-1: an owner session stores a 130 KB three-screen design for its mission', async () => {
    const { planStore } = await seam('store');
    const plan = planStore({ screens: SCREENS, attachTo: { kind: 'mission', id: 'm1' }, bytes: 130 * 1024 });
    expect(plan).toMatchObject({ revision: 1, attachedTo: { kind: 'mission', id: 'm1' } });
    expect(plan.screens).toHaveLength(3);
  });

  it('AC-2: a new export leaves the pin on revision 1 and a following link on 2', async () => {
    const { planStore, resolveRevision } = await seam('store');
    expect(planStore({ existing: { id: 'D', currentRevision: 1 }, screens: SCREENS }).revision).toBe(2);
    expect(resolveRevision({ currentRevision: 2, pinned: 1 })).toBe(1);
    expect(resolveRevision({ currentRevision: 2, follows: true })).toBe(2);
  });

  it('AC-3: a viewport of `wide` is refused naming viewport', async () => {
    const { parseScreens } = await seam('screens');
    const r = parseScreens([{ id: 'a', name: 'A', viewport: 'wide' }]);
    expect(r.ok).toBe(false);
    expect(r.field).toBe('viewport');
    expect(r.message).toContain('viewport');
  });

  it('AC-4: ?screen= shows the screen scaled to the column with a 100% option and a labelled frame', () => {
    expect(fitScale(1440, 390)).toBeLessThan(1);
    const html = frame(1, 'Mission design');
    expect(html).toMatch(/100\s?%/);
    const label = /aria-label="(Design preview[^"]*)"/.exec(html)![1];
    expect(label).toContain('Mission design');
    expect(label).toContain('1');
  });

  it('AC-5: the frame allows scripts only, loads from the storage origin, inserts no markup', () => {
    const tag = iframeTag(frame(1, 'T', 'https://s.test/x.html?sig=1'));
    expect(/sandbox="([^"]*)"/.exec(tag)![1]).toBe('allow-scripts');
    expect(tag).toContain('src="https://s.test/x.html');
    expect(tag).not.toContain('srcdoc');
    for (const f of FRAME_FILES) expect(readFileSync(f, 'utf8')).not.toMatch(/dangerouslySetInnerHTML/);
  });

  it('AC-6: each pinned design screen name links to that screen at the pinned revision', () => {
    const href = designPreviewHref('D', { screen: 'desktop-mission', revision: 1 });
    expect(href).toContain('screen=desktop-mission');
    expect(href).toContain('revision=1');
  });

  it('AC-7: a task with no design of its own is told the spec-pinned design, revision and criterion screens', async () => {
    const { designPromptSection } = await seam('prompt');
    const text = designPromptSection({ specDesign: { id: 'SPEC-D', revision: 4 }, criteria: [CRITERION] });
    expect(text).toContain('SPEC-D');
    expect(text).toMatch(/\b4\b/);
    expect(text).toContain('desktop-mission');
  });

  it('AC-8: the visual check pairs the design screen and built page at 1440x900 and names the screen', () => {
    const text = visualPrompt();
    // The desktop screen is drawn at, and captured at, 1440x900.
    expect(resolveDesignScreens({ screens: SCREENS }, null).find((x) => x.id === 'desktop-mission')?.viewport).toEqual({ width: 1440, height: 900 });
    expect(text).toContain('`viewport=1440x900` for desktop ones');
    // The plan names the criterion's screen, and the pair is stored under it.
    expect(text).toContain('"screens":["desktop-mission"]');
    expect(text).toContain('designs/<screen>.png');
    expect(text).toContain('cite the screen id in `observed`');
  });

  it('AC-9: a two-board canvas imports as two screens, with the link and source', () => {
    const out = exportCanvas(twoBoardCanvas(), { source: 'https://claude.ai/design/two' });
    expect(out.metadata.screens).toHaveLength(2);
    const [a, b] = out.metadata.screens.map((x) => x.id);
    expect(out.html).toContain(`href="#${b}"`);
    expect(out.html).toContain(`href="#${a}"`);
    expect(out.metadata.source).toBe('https://claude.ai/design/two');
  });
});
