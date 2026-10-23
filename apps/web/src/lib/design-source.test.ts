import { describe, it, expect } from 'bun:test';
import { resolveDesignSourceAtClaim, type DesignSourceDeps } from './design-source';

const TASK_D = '00000000-0000-4000-8000-0000000000a1';
const MISSION_D = '00000000-0000-4000-8000-0000000000a2';
const SPEC_D = '00000000-0000-4000-8000-0000000000a3';
const SPEC = '00000000-0000-4000-8000-0000000000b1';
const TASK_REV = '00000000-0000-4000-8000-0000000000c1';
const MISSION_REV = '00000000-0000-4000-8000-0000000000c2';

const CRITERIA = [
  { id: 'AC-1', screens: ['desktop-mission'] },
  { id: 'AC-2', screens: [] },
  { id: 'AC-3', screens: ['phone-mission', 'desktop-mission'] },
];

function deps(over: {
  taskLinks?: Array<{ artifactId: string; pinnedRevision: number | null; currentRevision: number }>;
  missionLinks?: Array<{ artifactId: string; pinnedRevision: number | null; currentRevision: number }>;
  missionSpec?: { specRevisionId: string; criteria?: string[] } | null;
  revisions?: Record<string, { design: unknown; criteria: Array<{ id: string; screens: string[] }> }>;
} = {}): DesignSourceDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    designLinks: async (kind) => { calls.push(`links:${kind}`); return (kind === 'task' ? over.taskLinks : over.missionLinks) ?? []; },
    missionSpecPin: async () => { calls.push('missionSpec'); return over.missionSpec ?? null; },
    specRevision: async (id) => { calls.push(`rev:${id}`); return over.revisions?.[id] ?? null; },
  };
}

const task = (context: Record<string, unknown> = {}, missionId: string | null = 'm1') => ({ id: 't1', missionId, context });
const specPin = { specSource: { specId: SPEC, specRevisionId: TASK_REV, revision: 3 } };

describe('resolveDesignSourceAtClaim', () => {
  it('no design anywhere: null, so the prompt has no design section', async () => {
    expect(await resolveDesignSourceAtClaim(task(), deps())).toBeNull();
  });

  it("the task's own design_reference link, at its pinned revision", async () => {
    const out = await resolveDesignSourceAtClaim(task(), deps({
      taskLinks: [{ artifactId: TASK_D, pinnedRevision: 2, currentRevision: 5 }],
      missionLinks: [{ artifactId: MISSION_D, pinnedRevision: null, currentRevision: 1 }],
    }));
    expect(out).toEqual({ artifactId: TASK_D, revision: 2, from: 'task' });
  });

  it("else the mission's link, at the current revision when unpinned", async () => {
    const out = await resolveDesignSourceAtClaim(task(), deps({
      missionLinks: [{ artifactId: MISSION_D, pinnedRevision: null, currentRevision: 4 }],
    }));
    expect(out).toEqual({ artifactId: MISSION_D, revision: 4, from: 'mission' });
  });

  it('else the design pinned on the spec revision the task builds, with the screens its criteria name', async () => {
    const out = await resolveDesignSourceAtClaim(task(specPin), deps({
      revisions: { [TASK_REV]: { design: { kind: 'artifact', ref: SPEC_D, version: '7' }, criteria: CRITERIA } },
    }));
    expect(out).toEqual({
      artifactId: SPEC_D, revision: 7, from: 'spec',
      screens: ['desktop-mission', 'phone-mission'],
      criteria: [{ id: 'AC-1', screens: ['desktop-mission'] }, { id: 'AC-3', screens: ['phone-mission', 'desktop-mission'] }],
    });
  });

  it("the mission's spec when the task names none", async () => {
    const d = deps({
      missionSpec: { specRevisionId: MISSION_REV },
      revisions: { [MISSION_REV]: { design: { kind: 'artifact', ref: SPEC_D, version: '1' }, criteria: CRITERIA } },
    });
    const out = await resolveDesignSourceAtClaim(task(), d);
    expect(out).toMatchObject({ artifactId: SPEC_D, revision: 1, from: 'spec' });
  });

  it("a linked design still gets the screens of the spec's criteria, narrowed to the task's scope", async () => {
    const out = await resolveDesignSourceAtClaim(
      task({ specSource: { ...specPin.specSource, criteria: ['AC-1'] } }),
      deps({
        taskLinks: [{ artifactId: TASK_D, pinnedRevision: null, currentRevision: 1 }],
        revisions: { [TASK_REV]: { design: { kind: 'artifact', ref: SPEC_D, version: '7' }, criteria: CRITERIA } },
      }),
    );
    expect(out).toEqual({ artifactId: TASK_D, revision: 1, from: 'task', screens: ['desktop-mission'], criteria: [{ id: 'AC-1', screens: ['desktop-mission'] }] });
  });

  it('a spec design that is a URL or design-tool file is not a buildd artifact', async () => {
    const out = await resolveDesignSourceAtClaim(task(specPin), deps({
      revisions: { [TASK_REV]: { design: { kind: 'figma', ref: 'https://figma.example/file', version: 'v1' }, criteria: CRITERIA } },
    }));
    expect(out).toBeNull();
  });

  it('keeps the claude.ai and copy-in forms the filer wrote, next to the resolved artifact', async () => {
    const filed = { sourceUrl: 'https://claude.ai/artifact/exampleCanvas1', artifactKeys: ['design:x/main'] };
    const out = await resolveDesignSourceAtClaim(task({ designSource: filed }), deps({
      missionLinks: [{ artifactId: MISSION_D, pinnedRevision: 3, currentRevision: 3 }],
    }));
    expect(out).toEqual({ ...filed, artifactId: MISSION_D, revision: 3, from: 'mission' });
  });

  it('a design artifact the filer named is left as it is, and nothing is read', async () => {
    const d = deps({ taskLinks: [{ artifactId: TASK_D, pinnedRevision: 1, currentRevision: 1 }] });
    expect(await resolveDesignSourceAtClaim(task({ designSource: { artifactId: MISSION_D } }), d)).toBeNull();
    expect(d.calls).toEqual([]);
  });

  it('no mission: the mission is never read', async () => {
    const d = deps();
    await resolveDesignSourceAtClaim(task({}, null), d);
    expect(d.calls).toEqual(['links:task']);
  });

  it('names the screens: the files own list (name, size), narrowed to the ones that matter when criteria name some', async () => {
    const all = [
      { id: 'desktop-mission', name: 'Mission (desktop)', viewport: '1440x900' },
      { id: 'phone-mission', name: 'Mission (phone)', viewport: '390x844' },
      { id: 'coverage', name: 'Coverage', viewport: '1440x900' },
    ];
    const d = { ...deps({ taskLinks: [{ artifactId: TASK_D, pinnedRevision: 2, currentRevision: 2 }] }), designScreens: async () => all };
    expect(await resolveDesignSourceAtClaim(task(), d)).toEqual({ artifactId: TASK_D, revision: 2, from: 'task', screenInfo: all });

    const scoped = { ...deps({
      taskLinks: [{ artifactId: TASK_D, pinnedRevision: null, currentRevision: 1 }],
      missionSpec: { specRevisionId: MISSION_REV },
      revisions: { [MISSION_REV]: { design: { kind: 'artifact', ref: SPEC_D, version: '1' }, criteria: CRITERIA } },
    }), designScreens: async () => all };
    const out = await resolveDesignSourceAtClaim(task(), scoped);
    expect(out?.screenInfo?.map((s) => s.id)).toEqual(['desktop-mission', 'phone-mission']);
  });

  it('a design whose screens cannot be read still resolves, without names', async () => {
    const d = { ...deps({ taskLinks: [{ artifactId: TASK_D, pinnedRevision: 1, currentRevision: 1 }] }), designScreens: async () => { throw new Error('db'); } };
    expect(await resolveDesignSourceAtClaim(task(), d)).toEqual({ artifactId: TASK_D, revision: 1, from: 'task' });
  });
});
