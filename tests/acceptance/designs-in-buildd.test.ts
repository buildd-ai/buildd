/**
 * Acceptance for mission "Designs in buildd": the automated half of the final
 * check. A two-board canvas (a desktop and a phone Mission board, the names
 * the Navigation spec's criteria use) goes through the same path a real
 * design takes: export, next revision, attach, deep link, sandboxed frame,
 * builder prompt, side-by-side plan. The steps that need a live deployment
 * (importing the real canvas, rendering in Visual QA, a surface audit on a
 * PR) are reported by hand in the task that owns this check.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportCanvas } from '../../scripts/design/export-canvas';
import { designScreensFromHtml, mapRoutesToScreens, parseDesignPlan } from '../../scripts/qa/design';
import { designHref } from '../../scripts/qa/design-capture';
import { planStore, resolveRevision } from '../../apps/web/src/lib/designs/store';
import { parseScreens } from '../../apps/web/src/lib/designs/screens';
import { designPreviewHref } from '../../apps/web/src/lib/design-preview';
import { designPromptSection } from '../../packages/shared/src/claude-ai-artifacts';

const ARTIFACT = '6356e80d-d2c5-4d52-878e-3025d23cf169';
const MISSION = '931eab56-0000-4000-8000-000000000000';

const roots: string[] = [];
afterAll(() => roots.forEach(r => rmSync(r, { recursive: true, force: true })));

function board(title: string, width: number, height: number): string {
  const props = JSON.stringify({ $preview: { width, height } });
  return `<!doctype html><html><head><title>${title}</title></head><body><x-dc>
<helmet><style>body{margin:0}</style></helmet>
<div style="width: ${width}px">${title}</div></x-dc>
<script type="text/x-dc" data-dc-script data-props='${props}'>class Component extends DCLogic {}</script></body></html>`;
}

function canvas(): string {
  const root = mkdtempSync(join(tmpdir(), 'designs-acceptance-'));
  roots.push(root);
  const project = join(root, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'canvas.json'), JSON.stringify({
    boards: [
      { file: 'Mission.dc.html', title: 'Mission', width: 1440, height: 900 },
      { file: 'MissionPhone.dc.html', title: 'Mission', width: 390, height: 844 },
    ],
  }));
  writeFileSync(join(project, 'screens.json'), JSON.stringify({ 'MissionPhone.dc.html': 'phone-mission' }));
  writeFileSync(join(project, 'Mission.dc.html'), board('Mission', 1440, 900));
  writeFileSync(join(project, 'MissionPhone.dc.html'), board('Mission', 390, 844));
  return project;
}

const exported = exportCanvas(canvas(), { title: 'Navigation', source: 'https://claude.ai/artifact/example' });

describe('import and upload', () => {
  test('the export declares both screens at their own sizes and keeps the canvas as source', () => {
    expect(exported.metadata.screens.map(s => [s.id, s.viewport])).toEqual([
      ['desktop-mission', '1440x900'],
      ['phone-mission', '390x844'],
    ]);
    expect(exported.metadata.source).toBe('https://claude.ai/artifact/example');
    expect(parseScreens(exported.metadata.screens)).toMatchObject({ ok: true });
  });

  test('uploading again is the next revision of the same design, attached to its mission', () => {
    const plan = planStore({
      existing: { id: ARTIFACT, currentRevision: 1 },
      screens: exported.metadata.screens,
      attachTo: { kind: 'mission', id: MISSION },
      bytes: Buffer.byteLength(exported.html),
    });
    expect(plan).toMatchObject({ id: ARTIFACT, revision: 2, attachedTo: { kind: 'mission', id: MISSION } });
  });

  test('a spec pinned to revision 1 keeps it; a following link moves to 2', () => {
    expect(resolveRevision({ currentRevision: 2, pinned: 1 })).toBe(1);
    expect(resolveRevision({ currentRevision: 2, follows: true })).toBe(2);
  });
});

describe('deep link', () => {
  test('a screen name links to that screen at the pinned revision', () => {
    const href = designPreviewHref(ARTIFACT, { screen: 'desktop-mission', revision: 1 });
    expect(href).toBe(`/app/artifacts/${ARTIFACT}?screen=desktop-mission&revision=1`);
    expect(designHref(ARTIFACT, 'phone-mission', 1)).toBe(`/app/artifacts/${ARTIFACT}?screen=phone-mission&revision=1`);
  });
});

describe('frame security', () => {
  const source = readFileSync(join(import.meta.dir, '../../apps/web/src/components/DesignPreview.tsx'), 'utf8');

  test('the only iframe is sandboxed to allow-scripts, with no referrer and no inserted markup', () => {
    expect(source.match(/<iframe\b/g)).toHaveLength(1);
    expect(source.match(/sandbox="([^"]*)"/g)).toEqual(['sandbox="allow-scripts"']);
    expect(source).toContain('referrerPolicy="no-referrer"');
    expect(source).not.toMatch(/dangerouslySetInnerHTML|srcDoc/);
  });
});

describe('build: the prompt section', () => {
  const criteria = [
    { id: 'AC-4', screens: ['phone-mission', 'desktop-mission'] },
    { id: 'AC-6', screens: [] },
  ];

  test('names the pinned artifact, its revision and the screens its criteria name', () => {
    const text = designPromptSection({ specDesign: { id: ARTIFACT, revision: 1 }, criteria });
    expect(text).toContain('## Design source');
    expect(text).toContain(ARTIFACT);
    expect(text).toContain('revision 1');
    expect(text).toContain('`phone-mission` (AC-4)');
    expect(text).toContain('`desktop-mission` (AC-4)');
    expect(text).not.toContain('AC-6');
  });

  test('the task design beats the mission design, which beats the spec design', () => {
    const text = designPromptSection({
      taskDesign: { id: 'TASK-D' }, missionDesign: { id: 'MISSION-D' }, specDesign: { id: 'SPEC-D' }, criteria,
    });
    expect(text).toContain('TASK-D');
    expect(text).not.toMatch(/MISSION-D|SPEC-D/);
  });

  test('no design means no section', () => {
    expect(designPromptSection({ criteria })).toBe('');
  });
});

describe('verify: design beside built', () => {
  const plan = parseDesignPlan(JSON.stringify({
    design: { file: '/tmp/design.html', artifactId: ARTIFACT, revision: 1 },
    criteria: [{ id: 'AC-4', screens: ['desktop-mission', 'phone-mission'] }],
    routes: {},
  }));
  const inFile = designScreensFromHtml(exported.html);

  test('the export declares the screen sizes the capture reads', () => {
    expect(inFile.get('desktop-mission')?.viewport).toEqual({ width: 1440, height: 900 });
    expect(inFile.get('phone-mission')?.viewport).toEqual({ width: 390, height: 844 });
  });

  test('the mission page pairs with desktop-mission at desktop and phone-mission at phone width', () => {
    const shot = (id: string, width: number, height: number) =>
      ({ id, path: '/app/missions/m1', screenshotFile: `${id}.png`, viewport: { width, height }, theme: 'light' });
    const desktop = mapRoutesToScreens(plan, inFile, [shot('d', 1440, 900)]);
    const phone = mapRoutesToScreens(plan, inFile, [shot('p', 390, 844)]);
    expect(desktop.pairs.map(p => p.screen)).toEqual(['desktop-mission']);
    expect(phone.pairs.map(p => p.screen)).toEqual(['phone-mission']);
    expect(desktop.pairs[0].criteria).toEqual(['AC-4']);
  });
});
