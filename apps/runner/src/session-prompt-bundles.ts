/**
 * A session's role and skill payload: getting it back for a resumed session,
 * and writing it into the session cwd.
 *
 * The claim response carries `skillBundles`, `roleConfig` (a presigned R2 URL
 * for the role bundle) and `roleInstructions`. The runner keeps them in memory
 * on the worker and writes them to disk only for one session
 * (session-prompt-files.ts), and none of them is in the persisted worker record.
 * So a worker restored from disk — after a runner restart, or a park → reattach
 * onto a fresh container — has none of it, and a resumed session would start
 * with no skills and no persona.
 *
 * `rehydratePromptBundles` closes that gap: before a resumed session starts it
 * re-fetches the payload from the server (GET /api/workers/[id]/prompt-bundles,
 * the claim route's own resolvers) and the role bundle from its fresh presigned
 * URL, so a resumed session has the same skill set a fresh one would.
 * `writeSessionPromptFiles` is what every session — fresh or resumed — then
 * runs, so the two cannot drift.
 */
import { fetchRoleBundle as defaultFetchRoleBundle, writeSessionRoleFiles, type RoleBundle, type RoleConfig, type RoleInstructions } from './roles.js';
import { syncSkillToLocal } from './skills.js';
import type { SkillBundle } from '@buildd/shared';
import type { LocalWorker } from './types.js';

/** GET /api/workers/[id]/prompt-bundles. Mirrors WorkerPromptBundlesResponse in @buildd/shared. */
export interface PromptBundlesPayload {
  skillBundles?: SkillBundle[];
  roleConfig?: RoleConfig;
  roleInstructions?: RoleInstructions;
}

type PromptWorker = Pick<LocalWorker, 'id' | 'skillBundles' | 'roleConfig' | 'roleBundle' | 'roleInstructions' | 'promptBundlesLoaded'>;

export interface RehydrateDeps {
  /** The server's answer, or null when it could not be had (unreachable, refused). */
  fetchPromptBundles: (workerId: string) => Promise<PromptBundlesPayload | null>;
  fetchRoleBundle?: (roleConfig: RoleConfig) => Promise<RoleBundle>;
}

export type RehydrateOutcome =
  /** The worker already holds this task's payload (claimed by this process). */
  | { kind: 'present' }
  | { kind: 'restored'; skills: string[]; role?: string }
  /** Fail-open: the session continues without; the next resume tries again. */
  | { kind: 'failed'; reason: string };

/**
 * Give a worker its role and skill payload back if it lost it. A no-op for a
 * worker this process claimed (`promptBundlesLoaded`). Never throws.
 */
export async function rehydratePromptBundles(worker: PromptWorker, deps: RehydrateDeps): Promise<RehydrateOutcome> {
  if (worker.promptBundlesLoaded) return { kind: 'present' };
  let payload: PromptBundlesPayload | null;
  try {
    payload = await deps.fetchPromptBundles(worker.id);
  } catch (err) {
    return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
  if (!payload) return { kind: 'failed', reason: 'prompt bundles unavailable from the server' };

  let roleBundle: RoleBundle | undefined;
  if (payload.roleConfig) {
    try {
      roleBundle = await (deps.fetchRoleBundle ?? defaultFetchRoleBundle)(payload.roleConfig);
    } catch (err) {
      return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  worker.skillBundles = payload.skillBundles && payload.skillBundles.length > 0 ? payload.skillBundles : undefined;
  worker.roleConfig = payload.roleConfig;
  worker.roleBundle = roleBundle;
  worker.roleInstructions = payload.roleInstructions;
  worker.promptBundlesLoaded = true;
  return {
    kind: 'restored',
    skills: (worker.skillBundles ?? []).map(b => b.slug),
    ...(payload.roleConfig || payload.roleInstructions ? { role: payload.roleConfig?.slug ?? payload.roleInstructions?.slug } : {}),
  };
}

export interface WriteSessionPromptFilesResult {
  /** True when anything landed in <cwd>/.claude/skills (the session needs the `project` setting source). */
  wroteSkills: boolean;
  /** Skill slugs written from the skill bundles, in order. */
  syncedSkills: string[];
}

/**
 * Write the worker's role and skill files into `cwd` for this session. Every
 * file is recorded in the worker's session manifest and removed with
 * cleanupSessionPromptFiles when the session ends. Never throws: a failed
 * write is reported through `note` and the session continues.
 */
export async function writeSessionPromptFiles(
  worker: Pick<LocalWorker, 'id' | 'skillBundles' | 'roleBundle'>,
  cwd: string,
  note: (label: string) => void = () => {},
): Promise<WriteSessionPromptFilesResult> {
  let wroteSkills = false;
  const syncedSkills: string[] = [];

  if (worker.roleBundle) {
    try {
      await writeSessionRoleFiles(worker.roleBundle, cwd, worker.id);
      if (worker.roleBundle.skills.length > 0) wroteSkills = true;
    } catch (err) {
      const label = `Role file write failed: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`[Worker ${worker.id}] ${label}`);
      note(label);
    }
  }

  for (const bundle of worker.skillBundles ?? []) {
    try {
      await syncSkillToLocal(bundle, { sessionCwd: cwd, workerId: worker.id });
      wroteSkills = true;
      syncedSkills.push(bundle.slug);
      note(`Skill synced: ${bundle.name}`);
    } catch (err) {
      console.error(`[Worker ${worker.id}] Failed to sync skill ${bundle.slug}:`, err);
      note(`Skill sync failed: ${bundle.slug}`);
    }
  }

  return { wroteSkills, syncedSkills };
}
