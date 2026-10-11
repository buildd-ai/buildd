import { db } from '@buildd/core/db';
import { specs, specRevisions } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { outlineOf, type OutlineSection } from '@buildd/core/artifact-read';
import { isUuid } from '@/lib/uuid';
import { getArtifactRevision } from '@/lib/artifact-revisions';
import { fail, reach, reviseSpecDraft, type SpecCaller, type SpecError, type SpecRevisionRow, type SpecRow } from './store';

/**
 * Revise one section of a spec without resending the whole body. The section
 * is named by its outline id (the ids get_artifact view=outline returns, `s1`,
 * `s2`, ...) or by a heading that appears exactly once. Its span, heading line
 * included and running to the next heading at the same or a higher level, is
 * replaced by `body`; everything else stays byte for byte.
 *
 * The result goes through reviseSpecDraft as a whole new body, so the version
 * check, hashing, immutability and approval rules are the full-body ones: a
 * stale expectedVersion is a 409 with currentVersion, and on an approved spec
 * the result is a proposed N+1. Outline ids are only stable within one
 * revision, which the version check guarantees: the ids refer to the revision
 * the writer read.
 */

export type SectionTarget = { section?: unknown; heading?: unknown };

/** The section a target names in `body`, or why none does. */
export function findSection(body: string, target: SectionTarget): OutlineSection | string {
  const hasId = target.section !== undefined && target.section !== null;
  const hasHeading = target.heading !== undefined && target.heading !== null;
  if (hasId === hasHeading) return 'name the section with exactly one of section (an outline id) or heading';
  const outline = outlineOf(body);
  if (hasId) {
    const found = outline.find((s) => s.id === target.section);
    return found ?? `no section ${String(target.section)}; read view=outline for the ids`;
  }
  if (typeof target.heading !== 'string' || !target.heading.trim()) return 'heading must be the heading text';
  const want = target.heading.trim().replace(/^#+\s*/, '');
  const matches = outline.filter((s) => s.title === want);
  if (matches.length === 0) return `no heading "${want}"; read view=outline for the headings`;
  if (matches.length > 1) return `heading "${want}" appears ${matches.length} times (${matches.map((m) => m.id).join(', ')}); name it by section id`;
  return matches[0];
}

/** `body` with `section`'s span replaced by `text`, never running `text` into the heading that follows. */
export function spliceSection(body: string, section: OutlineSection, text: string): string {
  const joined = text && section.end < body.length && !text.endsWith('\n') ? `${text}\n` : text;
  return body.slice(0, section.start) + joined + body.slice(section.end);
}

export async function reviseSpecSection(caller: SpecCaller, specId: string, input: SectionTarget & {
  expectedVersion: unknown; body: unknown; changeSummary?: unknown; repoRefs?: unknown;
}): Promise<{ ok: true; spec: SpecRow; revision: SpecRevisionRow; unchanged: boolean } | SpecError> {
  if (!isUuid(specId)) return fail(404, 'Spec not found');
  if (!Number.isInteger(input.expectedVersion)) return fail(400, 'expectedVersion (the spec version you read) is required');
  if (typeof input.body !== 'string' || !input.body.trim()) return fail(400, 'body (the new text of the section, its heading line included) is required');
  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec || !(await reach(caller, spec.workspaceId, true))) return fail(404, 'Spec not found');
  if (spec.version !== input.expectedVersion) {
    return fail(409, `The spec changed since version ${input.expectedVersion as number}: it is now at version ${spec.version}. Re-read it, then revise the section on top.`, { currentVersion: spec.version });
  }
  const [head] = await db.select().from(specRevisions).where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, spec.headRevision))).limit(1);
  const current = (await getArtifactRevision(spec.bodyArtifactId, head.artifactRevision))?.content ?? '';
  const section = findSection(current, input);
  if (typeof section === 'string') return fail(400, `${section}; nothing was written`);
  return reviseSpecDraft(caller, specId, {
    expectedVersion: input.expectedVersion, body: spliceSection(current, section, input.body),
    changeSummary: input.changeSummary, repoRefs: input.repoRefs,
  });
}
