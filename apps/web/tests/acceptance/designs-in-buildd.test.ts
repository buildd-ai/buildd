/**
 * Acceptance checks for Living Spec f43b6a61 "Designs in buildd", revision 1.
 * Written before the build: each test fails on the starting commit and passes
 * once the spec is built. Each check is listed in the spec's metadata
 * `verified_by`, keyed by its id.
 *
 * Seam contract the build provides (pure functions under src/lib/designs/, so
 * the checks need no database or browser):
 *   screens.ts  parseScreens(raw) -> { ok: true, screens } | { ok: false, field, message }
 *   store.ts    planStore({ existing?, screens, attachTo?, bytes? }) -> { id?, revision, screens, attachedTo }
 *               resolveRevision({ currentRevision, pinned?, follows? }) -> number
 *   view.ts     screenView({ screen, columnWidth }) -> { scale, actualSizeOption }
 *               designScreenHref({ designId, screen, revision? }) -> string
 *   frame.ts    designFrame({ storageOrigin, src, revision, title }) -> { sandbox, src, label }
 *   prompt.ts   designPromptSection({ taskDesign?, missionDesign?, specDesign?, criteria }) -> string
 *   visual.ts   designComparisonPlan({ criterion, design, builtUrl }) -> { design, built, viewport, verdictScreen, designHref }[]
 *   canvas.ts   importCanvas({ url, boards, links }) -> { screens, source, links }
 * Components that draw a frame live in the same directory as .tsx files.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..', '..', 'src');
const DESIGNS = join(SRC, 'lib', 'designs');

/** Load a seam module; a missing one fails with a short message. */
async function seam(name: string): Promise<any> {
  const file = ['.ts', '.tsx'].map(e => join(DESIGNS, name + e)).find(existsSync);
  if (!file) throw new Error(`src/lib/designs/${name}.ts does not exist yet`);
  return import(file);
}

const components = () => (existsSync(DESIGNS) ? readdirSync(DESIGNS).filter(n => n.endsWith('.tsx') && !n.includes('.test.')) : []);

const SCREENS = [
  { id: 'desktop-mission', name: 'Mission', viewport: '1440x900' },
  { id: 'phone-mission', name: 'Mission (phone)', viewport: '390x844' },
  { id: 'desktop-task', name: 'Task', viewport: '1440x900' },
];
const CRITERION = { id: 'AC-8', screens: ['desktop-mission'] };
const DESIGN = { id: 'D', revision: 1, screens: SCREENS };

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

  it('R-5: a canvas becomes a design keeping its address as source', async () => {
    const { importCanvas } = await seam('canvas');
    const out = importCanvas({ url: 'https://claude.ai/design/abc', boards: [{ id: 'a', name: 'A', viewport: '390x844' }], links: [] });
    expect(out.source).toBe('https://claude.ai/design/abc');
  });
});

describe('view', () => {
  it('R-6: a screen is scaled to the column with a 100% option', async () => {
    const { screenView } = await seam('view');
    const v = screenView({ screen: SCREENS[0], columnWidth: 360 });
    expect(v.scale).toBeCloseTo(360 / 1440, 3);
    expect(v.actualSizeOption).toBe(true);
  });

  it('R-7: a link opens one screen of one revision', async () => {
    const { designScreenHref } = await seam('view');
    const href = designScreenHref({ designId: 'D', screen: 'desktop-mission', revision: 1 });
    expect(href).toContain('/app/artifacts/D');
    expect(href).toContain('screen=desktop-mission');
    expect(href).toMatch(/revision=1|rev=1/);
  });

  it('R-8: a design runs in a script-only sandbox on the storage origin', async () => {
    const { designFrame } = await seam('frame');
    const f = designFrame({ storageOrigin: 'https://files.example.test', src: 'https://files.example.test/d.html', revision: 2, title: 'T' });
    expect(f.sandbox.split(/\s+/)).toEqual(['allow-scripts']);
    expect(f.label).toMatch(/design preview/i);
    expect(f.label).toContain('2');
  });

  it('R-9: the frame uses design-system tokens, not literal colours', () => {
    const files = components();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(join(DESIGNS, f), 'utf8')).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
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

  it('R-11: the visual check renders each criterion screen beside the built page', async () => {
    const { designComparisonPlan } = await seam('visual');
    const plan = designComparisonPlan({ criterion: CRITERION, design: DESIGN, builtUrl: 'http://x/app/missions/1' });
    expect(plan).toHaveLength(1);
    expect(plan[0].viewport).toBe('1440x900');
  });

  it('R-12: both images are kept as evidence and the design screen can be opened', async () => {
    const { designComparisonPlan } = await seam('visual');
    const [p] = designComparisonPlan({ criterion: CRITERION, design: DESIGN, builtUrl: 'http://x' });
    expect(p.design).toBeDefined();
    expect(p.built).toBeDefined();
    expect(p.designHref).toContain('screen=desktop-mission');
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

  it('AC-4: ?screen= shows the screen scaled to the column with a 100% option and a labelled frame', async () => {
    const { screenView } = await seam('view');
    const { designFrame } = await seam('frame');
    const v = screenView({ screen: SCREENS[0], columnWidth: 390 });
    expect(v.scale).toBeLessThan(1);
    expect(v.actualSizeOption).toBe(true);
    const f = designFrame({ storageOrigin: 'https://s.test', src: 'https://s.test/x.html', revision: 1, title: 'Mission design' });
    expect(f.label).toContain('Mission design');
    expect(f.label).toContain('1');
  });

  it('AC-5: the frame allows scripts only, loads from the storage origin, inserts no markup', async () => {
    const { designFrame } = await seam('frame');
    const f = designFrame({ storageOrigin: 'https://s.test', src: 'https://s.test/x.html', revision: 1, title: 'T' });
    expect(f.sandbox).toBe('allow-scripts');
    expect(f.src.startsWith('https://s.test/')).toBe(true);
    for (const c of components()) expect(readFileSync(join(DESIGNS, c), 'utf8')).not.toMatch(/dangerouslySetInnerHTML/);
  });

  it('AC-6: each pinned design screen name links to that screen at the pinned revision', async () => {
    const { designScreenHref } = await seam('view');
    const href = designScreenHref({ designId: 'D', screen: 'desktop-mission', revision: 1 });
    expect(href).toContain('screen=desktop-mission');
    expect(href).toMatch(/revision=1|rev=1/);
  });

  it('AC-7: a task with no design of its own is told the spec-pinned design, revision and criterion screens', async () => {
    const { designPromptSection } = await seam('prompt');
    const text = designPromptSection({ specDesign: { id: 'SPEC-D', revision: 4 }, criteria: [CRITERION] });
    expect(text).toContain('SPEC-D');
    expect(text).toMatch(/\b4\b/);
    expect(text).toContain('desktop-mission');
  });

  it('AC-8: the visual check pairs the design screen and built page at 1440x900 and names the screen', async () => {
    const { designComparisonPlan } = await seam('visual');
    const [p] = designComparisonPlan({ criterion: CRITERION, design: DESIGN, builtUrl: 'http://x' });
    expect(p.viewport).toBe('1440x900');
    expect(p.verdictScreen).toBe('desktop-mission');
  });

  it('AC-9: a two-board canvas imports as two screens, with the link and source', async () => {
    const { importCanvas } = await seam('canvas');
    const out = importCanvas({
      url: 'https://claude.ai/design/two',
      boards: [{ id: 'a', name: 'A', viewport: '390x844' }, { id: 'b', name: 'B', viewport: '390x844' }],
      links: [{ from: 'a', to: 'b' }],
    });
    expect(out.screens).toHaveLength(2);
    expect(out.links).toContainEqual({ from: 'a', to: 'b' });
    expect(out.source).toBe('https://claude.ai/design/two');
  });
});
