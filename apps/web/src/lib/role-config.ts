import { createHash } from 'crypto';
import { db } from '@buildd/core/db';
import { workspaceSkills } from '@buildd/core/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { uploadBuffer, deleteObject } from './storage';

export interface RoleConfigInput {
  slug: string;
  claudeMd: string;
  mcpConfig: Record<string, unknown>;
  envMapping: Record<string, string>;
  skillSlugs: string[];
  type: 'builder' | 'service';
  repoUrl?: string | null;
}

export interface RoleConfigBundle {
  slug: string;
  type: 'builder' | 'service';
  claudeMd: string;
  mcpConfig: Record<string, unknown>;
  envMapping: Record<string, string>;
  skills: { slug: string; name: string; content: string }[];
  repoUrl: string | null;
}

export interface UploadResult {
  configHash: string;
  configStorageKey: string;
}

/**
 * Resolves skill slugs from the database and builds a JSON config bundle
 * ready for upload to R2.
 */
export async function packageRoleConfig(
  workspaceId: string,
  input: RoleConfigInput,
): Promise<RoleConfigBundle> {
  let skills: { slug: string; name: string; content: string }[] = [];

  if (input.skillSlugs.length > 0) {
    const rows = await db
      .select({
        slug: workspaceSkills.slug,
        name: workspaceSkills.name,
        content: workspaceSkills.content,
      })
      .from(workspaceSkills)
      .where(
        and(
          eq(workspaceSkills.workspaceId, workspaceId),
          inArray(workspaceSkills.slug, input.skillSlugs),
        ),
      );

    skills = rows.map((r) => ({ slug: r.slug, name: r.name, content: r.content }));
  }

  return {
    slug: input.slug,
    type: input.type,
    claudeMd: input.claudeMd,
    mcpConfig: input.mcpConfig,
    envMapping: input.envMapping,
    skills,
    repoUrl: input.repoUrl ?? null,
  };
}

/**
 * Uploads a role config bundle to R2 as JSON.
 * Returns the content hash and storage key for cache invalidation.
 */
export async function uploadRoleConfig(bundle: RoleConfigBundle): Promise<UploadResult> {
  const json = JSON.stringify(bundle);
  const configHash = createHash('sha256').update(json).digest('hex');
  const configStorageKey = `roles/${bundle.slug}/${configHash}.json`;

  await uploadBuffer(configStorageKey, Buffer.from(json, 'utf-8'), 'application/json');

  return { configHash, configStorageKey };
}

/**
 * Removes a role config bundle from R2.
 */
export async function deleteRoleConfig(storageKey: string): Promise<void> {
  await deleteObject(storageKey);
}
