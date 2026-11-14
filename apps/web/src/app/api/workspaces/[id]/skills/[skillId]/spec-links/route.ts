// /api/workspaces/[id]/skills/[skillId]/spec-links
//
// GET    suggestions (computed on read, never stored) plus the confirmed links.
// POST   { specId } confirm a link. Person-only: any bearer token (agent) gets 403.
// DELETE { specId } remove a confirmed link. Person-only.
//
// A score never retires a skill; only a confirmed link can feed a retirement
// proposal (cron/skill-lifecycle), and a proposal is never a disable.

import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { skillSpecLinks, specs, tasks, workspaceSkills } from '@buildd/core/db/schema';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import {
  assertPersonCaller, rankSkillSpecSuggestions, SkillSpecLinkRefusedError,
} from '@buildd/core/skill-spec-links';

type Ctx = { params: Promise<{ id: string; skillId: string }> };

async function personOr(req: NextRequest, workspaceId: string) {
  try {
    // Any bearer token is an agent or an API client: refused before any lookup.
    assertPersonCaller(req.headers.get('authorization') ? 'api' : 'session');
  } catch (err) {
    if (err instanceof SkillSpecLinkRefusedError) {
      return { res: NextResponse.json({ error: err.message }, { status: 403 }) } as const;
    }
    throw err;
  }
  const user = await getCurrentUser();
  if (!user) return { res: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as const;
  const access = await verifyWorkspaceAccess(user.id, workspaceId);
  if (!access) return { res: NextResponse.json({ error: 'Workspace not found' }, { status: 404 }) } as const;
  return { user, access } as const;
}

async function load(workspaceId: string, skillId: string, specId: string | null) {
  const skill = await db.query.workspaceSkills.findFirst({
    where: sqlWhere(and(eq(workspaceSkills.id, skillId), eq(workspaceSkills.workspaceId, workspaceId))),
  });
  if (!skill) return { error: NextResponse.json({ error: 'Skill not found' }, { status: 404 }) } as const;
  if (!specId) return { skill, spec: null } as const;
  const spec = await db.query.specs.findFirst({
    where: sqlWhere(and(eq(specs.id, specId), eq(specs.workspaceId, workspaceId))),
  });
  if (!spec) return { error: NextResponse.json({ error: 'Spec not found' }, { status: 404 }) } as const;
  return { skill, spec } as const;
}

async function readSpecId(req: NextRequest): Promise<string | null> {
  const body = await req.json().catch(() => null) as { specId?: unknown } | null;
  return typeof body?.specId === 'string' && body.specId ? body.specId : null;
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const { id, skillId } = await params;
  const who = await personOr(req, id);
  if ('res' in who) return who.res;
  const specId = await readSpecId(req);
  if (!specId) return NextResponse.json({ error: 'specId is required' }, { status: 400 });
  const found = await load(id, skillId, specId);
  if ('error' in found) return found.error;
  const rows = await db.insert(skillSpecLinks).values({
    skillId, specId, teamId: found.skill.teamId, confirmedBy: who.user.id,
  }).onConflictDoNothing().returning();
  return NextResponse.json({ ok: true, created: rows.length > 0 }, { status: 201 });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { id, skillId } = await params;
  const who = await personOr(req, id);
  if ('res' in who) return who.res;
  const specId = await readSpecId(req);
  if (!specId) return NextResponse.json({ error: 'specId is required' }, { status: 400 });
  const found = await load(id, skillId, specId);
  if ('error' in found) return found.error;
  await db.delete(skillSpecLinks)
    .where(and(eq(skillSpecLinks.skillId, skillId), eq(skillSpecLinks.specId, specId))).returning();
  return NextResponse.json({ ok: true });
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const { id, skillId } = await params;
  const who = await personOr(req, id);
  if ('res' in who) return who.res;
  const found = await load(id, skillId, null);
  if ('error' in found) return found.error;
  const { skill } = found;

  const [links, wsSpecs, usedTasks] = await Promise.all([
    db.select().from(skillSpecLinks).where(eq(skillSpecLinks.skillId, skillId)),
    db.select({ id: specs.id, title: specs.title, status: specs.status, metadata: specs.metadata })
      .from(specs).where(eq(specs.workspaceId, id)),
    db.select({ pathManifest: tasks.pathManifest, context: tasks.context })
      .from(tasks).where(eq(tasks.workspaceId, id)).limit(500),
  ]);

  // Observed: paths of tasks that were handed this skill, against each spec's declared surfaces.
  const used = usedTasks.filter(t => {
    const slugs = (t.context as { skillSlugs?: unknown } | null)?.skillSlugs;
    return Array.isArray(slugs) && slugs.includes(skill.slug);
  });
  const paths = new Set(used.flatMap(t => t.pathManifest ?? []));
  const pathOverlap = wsSpecs.map(s => {
    const surfaces = s.metadata?.surfaces ?? [];
    const shared = [...paths].filter(p => surfaces.some(sf => p === sf || p.startsWith(sf.endsWith('/') ? sf : `${sf}/`)));
    return { specId: s.id, sharedPaths: shared, taskCount: used.length };
  });

  // Embedding: computed on read; the score and matched text are shown, never acted on.
  let similar: Array<{ specId: string; score: number; matchedText: string }> = [];
  try {
    const { specCorpusShortlist } = await import('@/lib/specs/knowledge');
    const matches = await specCorpusShortlist({ workspaceId: id, title: skill.name ?? skill.slug, body: skill.content, drafts: false });
    similar = matches.map(m => ({
      specId: m.specId, score: m.score,
      matchedText: m.pairs[0] ? `${m.pairs[0].there} (${m.mode})` : m.mode,
    }));
  } catch (err) {
    console.warn('[skill-spec-links] similarity unavailable:', err instanceof Error ? err.message : err);
  }

  const titles = new Map(wsSpecs.map(s => [s.id, { title: s.title, status: s.status }]));
  const confirmed = new Set(links.map(l => l.specId));
  const suggestions = rankSkillSpecSuggestions({ similar, pathOverlap })
    .filter(s => !confirmed.has(s.specId))
    .map(s => ({ ...s, spec: titles.get(s.specId) ?? null }));
  return NextResponse.json({
    links: links.map(l => ({ specId: l.specId, confirmedBy: l.confirmedBy, createdAt: l.createdAt, spec: titles.get(l.specId) ?? null })),
    suggestions,
  });
}
