import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, artifacts, workspaces, tasks, missions, initiatives, specs } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { authenticateTaskScopedCaller, taskScopeAllowsWorker, taskScopeAllowsWorkspace, taskScopeAllowsMission, taskScopeAllowsInitiative, type TaskScopedAccount } from '@/lib/task-token-auth';
import { verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { validateDesignMetadata } from '@/lib/artifact-design';
import { startFileRevision, PENDING_REVISION_KEY } from '@/lib/artifact-upload';
import { checkPendingLink, linkArtifact, PENDING_LINKS_KEY, type LinkCaller, type PendingLink } from '@/lib/artifact-links';
import { reach } from '@/lib/specs/store';
import { isStorageConfigured, generateSizedUploadUrl } from '@/lib/storage';
import { buildArtifactKey, buildAuditScreenshotKey, uploadStagingKey } from '@/lib/storage-keys';
import { ARTIFACT_TYPES, ArtifactType, isArtifactType, VISUAL_AUDITOR_ROLE_SLUG } from '@buildd/shared';
import { appBaseUrl } from '@/lib/app-url';
import { triggerEvent, channels } from '@/lib/pusher';
import { sqlWhere } from '@buildd/core/db/relational-sql';

/**
 * Ceiling for a single artifact upload, enforced in the signature.
 *
 * 50MB is the limit this endpoint has always advertised, so nothing that works
 * today stops working; the change is that the value is now bound into the
 * presigned PUT instead of only being compared against a self-reported number.
 * Artifacts are agent deliverables — reports, logs, screenshots, small data
 * exports — and R2 egress is billed, so the ceiling stays where the product
 * contract already put it rather than being raised speculatively.
 */
export const MAX_ARTIFACT_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Links an upload may ask for in the same call (`attach`); the links table's own rules apply. */
export const MAX_ATTACH = 10;
const ATTACH_SUBJECTS = ['mission', 'task', 'spec'];
type AttachInput = { subjectKind: unknown; subjectId: unknown; relation?: unknown };

/** Server-owned metadata keys a caller never writes (lib/artifact-upload.ts, lib/artifact-links.ts). */
function withoutServerKeys(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const { [PENDING_REVISION_KEY]: _r, [PENDING_LINKS_KEY]: _l, finalizingAt: _f, uploadError: _u, revisionUploadError: _e, ...rest } = metadata ?? {};
  return rest;
}

const linkCallerOf = (account: TaskScopedAccount): LinkCaller => ({ kind: 'account', account, taskScope: account.taskScope ? { workspaceId: account.taskScope.workspaceId } : null });

// POST /api/artifacts/upload-url - Get a presigned upload URL and create artifact record
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  // A per-task token uploads only for its own task's worker.
  const account = await authenticateTaskScopedCaller(apiKey, req);

  if (!account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!isStorageConfigured()) {
    return NextResponse.json({ error: 'Storage not configured' }, { status: 503 });
  }

  const body = await req.json();
  const { workerId, filename, mimeType, sizeBytes, title, type, missionId, initiativeId, specId, artifactId, attach } = body as {
    workerId?: string;
    missionId?: string | null;
    initiativeId?: string | null;
    specId?: string | null;
    /** An existing file artifact: this upload is its next revision. */
    artifactId?: string | null;
    attach?: AttachInput[];
    filename: string;
    mimeType: string;
    sizeBytes: number;
    title?: string;
    type?: string;
    metadata?: Record<string, unknown>;
  };

  if (!filename || !mimeType || sizeBytes === undefined || sizeBytes === null) {
    return NextResponse.json(
      { error: 'filename, mimeType, and sizeBytes are required' },
      { status: 400 }
    );
  }

  // The declared size is signed into the upload grant, so it has to be a real
  // byte count before we can sign anything with it.
  if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    return NextResponse.json(
      { error: 'sizeBytes must be a positive integer' },
      { status: 400 }
    );
  }

  if (type !== undefined && type !== null && type !== '' && !isArtifactType(type)) {
    return NextResponse.json(
      { error: `Invalid type. Must be one of: ${ARTIFACT_TYPES.join(', ')}` },
      { status: 400 }
    );
  }

  if (sizeBytes > MAX_ARTIFACT_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `File exceeds ${MAX_ARTIFACT_UPLOAD_BYTES / (1024 * 1024)}MB limit` },
      { status: 413 }
    );
  }

  const rawMetadata = (body as { metadata?: unknown }).metadata;
  if (rawMetadata !== undefined && rawMetadata !== null && (typeof rawMetadata !== 'object' || Array.isArray(rawMetadata))) {
    return NextResponse.json({ error: 'metadata must be an object' }, { status: 400 });
  }
  const metadata = withoutServerKeys(rawMetadata as Record<string, unknown> | undefined);

  if (attach !== undefined && attach !== null) {
    if (!Array.isArray(attach) || attach.length > MAX_ATTACH) {
      return NextResponse.json({ error: `attach must be a list of at most ${MAX_ATTACH} { subjectKind, subjectId, relation }` }, { status: 400 });
    }
    for (const [i, a] of attach.entries()) {
      if (!a || typeof a !== 'object' || !ATTACH_SUBJECTS.includes(a.subjectKind as string)) {
        return NextResponse.json({ error: `attach[${i}].subjectKind must be one of: ${ATTACH_SUBJECTS.join(', ')}` }, { status: 400 });
      }
    }
  }
  const attachList = (attach ?? []).map(a => ({ ...a, relation: a.relation ?? 'design_reference' }));

  for (const [name, v] of [['missionId', missionId], ['initiativeId', initiativeId], ['specId', specId], ['artifactId', artifactId]] as const) {
    if (v !== undefined && v !== null && (typeof v !== 'string' || !UUID_RE.test(v))) {
      return NextResponse.json({ error: `${name} must be a uuid` }, { status: 400 });
    }
  }

  if (artifactId) return newRevision(account, artifactId, { filename, mimeType, sizeBytes, title, metadata: rawMetadata === undefined ? null : metadata, attach: attachList });

  const designError = validateDesignMetadata(metadata);
  if (designError) return NextResponse.json({ error: designError }, { status: 400 });

  // Without a worker, a person's session (or an account key) stores a file
  // against a mission, initiative or spec of its own team: the artifact is
  // authored by the account instead of a worker, as a spec attachment is.
  const workerless = !workerId;
  const scopes = [missionId, initiativeId, specId].filter(Boolean);
  if (workerless && scopes.length === 0) {
    return NextResponse.json(
      { error: 'workerId, or a missionId / initiativeId / specId to scope the upload to, is required' },
      { status: 400 }
    );
  }

  let worker: typeof workers.$inferSelect | undefined;
  let workspaceId: string | null = null;
  let artifactMissionId: string | null = null;
  let artifactInitiativeId: string | null = null;
  let isAuditShot = false;

  if (workerless && specId) {
    if (scopes.length > 1) {
      return NextResponse.json({ error: 'Send one of missionId, initiativeId or specId, not several' }, { status: 400 });
    }
    // A spec's file goes in the spec's workspace, for a caller who may change that workspace.
    const spec = await db.query.specs.findFirst({ where: sqlWhere(eq(specs.id, specId)), columns: { workspaceId: true } });
    if (!spec || !(await reach({ kind: 'account', account }, spec.workspaceId, false))) {
      return NextResponse.json({ error: 'Spec not found' }, { status: 404 });
    }
    if (!(await reach({ kind: 'account', account }, spec.workspaceId, true))) {
      return NextResponse.json({ error: 'You may read this spec but not store files for it' }, { status: 403 });
    }
    workspaceId = spec.workspaceId;
  } else if (workerless) {
    if (scopes.length > 1) {
      return NextResponse.json({ error: 'Send one of missionId, initiativeId or specId, not several' }, { status: 400 });
    }
    const scope = missionId
      ? await db.query.missions.findFirst({ where: sqlWhere(eq(missions.id, missionId)), columns: { teamId: true, workspaceId: true } })
      : await db.query.initiatives.findFirst({ where: sqlWhere(eq(initiatives.id, initiativeId as string)), columns: { teamId: true, workspaceId: true } });
    const allowed = !!scope && scope.teamId === account.teamId
      && (missionId ? await taskScopeAllowsMission(account, missionId) : await taskScopeAllowsInitiative(account, initiativeId))
      && taskScopeAllowsWorkspace(account, scope.workspaceId);
    if (!scope || !allowed) {
      return NextResponse.json({ error: `${missionId ? 'Mission' : 'Initiative'} not found` }, { status: 404 });
    }
    if (!scope.workspaceId) {
      return NextResponse.json(
        { error: 'A team-level mission or initiative has no workspace to store the file under; upload from a worker instead' },
        { status: 400 }
      );
    }
    workspaceId = scope.workspaceId;
    artifactMissionId = missionId ?? null;
    artifactInitiativeId = initiativeId ?? null;
  } else {
    worker = await db.query.workers.findFirst({
      where: sqlWhere(eq(workers.id, workerId as string)),
    });

    if (!worker) {
      return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
    }

    if (worker.accountId !== account.id || !taskScopeAllowsWorker(account, worker)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    workspaceId = worker.workspaceId;
  }

  // Sensitive workspaces: block R2 uploads entirely (content must not leave the runner)
  if (workspaceId) {
    const wsRow = await db.query.workspaces.findFirst({
      where: sqlWhere(eq(workspaces.id, workspaceId)),
      columns: { dataClass: true },
    });
    if (wsRow?.dataClass === 'sensitive') {
      return NextResponse.json(
        { error: 'Content upload is not permitted for sensitive workspaces' },
        { status: 403 }
      );
    }
  }

  // The workspace id is the tenant segment of the key; without one there is no
  // prefix to scope the upload to.
  if (!workspaceId) {
    return NextResponse.json(
      { error: 'Worker is not associated with a workspace' },
      { status: 400 }
    );
  }

  if (worker) {
    // Mission scoping, so a mission page can find the artifact (e.g. a visual
    // audit's screenshots). The mission is always the worker's own task's,
    // decided here, never trusted from the client: the same rule as
    // create_artifact (workers/[id]/artifacts). An explicit `missionId` is only
    // accepted when it names that same mission. Comparing ids (not
    // missions.workspaceId) is deliberate: team-level missions have a NULL
    // workspaceId, and a task's own mission is authorized by the task.
    const linkedTask = worker.taskId
      ? await db.query.tasks.findFirst({
          where: sqlWhere(eq(tasks.id, worker.taskId)),
          columns: { missionId: true, roleSlug: true },
        })
      : null;
    const taskMissionId = linkedTask?.missionId ?? null;
    if (missionId && missionId !== taskMissionId) {
      return NextResponse.json(
        { error: taskMissionId
            ? "missionId does not match the worker's task mission"
            : "missionId was sent but the worker's task has no mission" },
        { status: 400 }
      );
    }
    artifactMissionId = taskMissionId;
    // A visual-auditor's screenshot goes to the qa/ area
    // (docs/design/visual-qa-auditor.md, "Decay"): the prefix the lifecycle rule
    // expires, and the marker share refusal and prominence read. The role is the
    // worker's own task's, never the body's. The evidence check accepts this key
    // shape exactly as it accepts the artifacts/ one (mintedByUploadUrl).
    isAuditShot = type === ArtifactType.SCREENSHOT && linkedTask?.roleSlug === VISUAL_AUDITOR_ROLE_SLUG;
  }

  const uuid = randomUUID();
  let storageKey: string;
  try {
    storageKey = isAuditShot
      ? buildAuditScreenshotKey(workspaceId, uuid, filename)
      : buildArtifactKey(workspaceId, uuid, filename);
  } catch {
    return NextResponse.json({ error: 'Unable to derive a storage key' }, { status: 400 });
  }

  // This route used to accept `type` unvalidated (`type || FILE`), so it was the
  // one writer that could persist a type no reader knows how to render. Absent
  // still defaults to `file`; present must be in the shared vocabulary.
  const artifactType = type === undefined || type === null || type === ''
    ? ArtifactType.FILE
    : type;
  const artifactTitle = title || filename;

  // attach: checked now with the caller's reach, written once the bytes are
  // verified (a link needs verified bytes; lib/artifact-links.ts).
  const pendingLinks: PendingLink[] = [];
  for (const [i, a] of attachList.entries()) {
    const checked = await checkPendingLink(linkCallerOf(account), { workspaceId }, a);
    if (!checked.ok) return NextResponse.json({ error: `attach[${i}]: ${checked.error}` }, { status: checked.status });
    pendingLinks.push(checked.link);
  }

  const [artifact] = await db
    .insert(artifacts)
    .values({
      // The row id IS the key's upload id (artifacts|qa/<ws>/<id>/<name>). That
      // binds this row to the object only this route minted: a row written
      // elsewhere with a caller-chosen storageKey can't carry a matching id,
      // which is what the visual-audit evidence check relies on.
      id: uuid,
      workerId: worker?.id ?? null,
      workspaceId,
      missionId: artifactMissionId,
      initiativeId: artifactInitiativeId,
      ...(worker ? {} : { contentAuthor: `account:${account.id}` }),
      type: artifactType,
      title: artifactTitle,
      storageKey,
      // Ready only once its bytes are verified (lib/artifact-upload.ts).
      uploadState: 'pending',
      // Private until an explicit Share: a token is a bearer credential and
      // POST /api/artifacts/[artifactId]/share is the only thing that mints one.
      shareToken: null,
      visibility: 'private',
      metadata: {
        ...metadata,
        ...(pendingLinks.length ? { [PENDING_LINKS_KEY]: pendingLinks } : {}),
        // The caller's own name, kept verbatim for display; the object key uses
        // a reduced form of it.
        filename,
        mimeType,
        sizeBytes,
      },
    })
    .returning();

  // Signed for the staging key: finalize copies the verified bytes to storageKey,
  // which no signed URL can write (lib/artifact-upload.ts).
  const uploadUrl = await generateSizedUploadUrl(uploadStagingKey(storageKey), mimeType, sizeBytes);

  // An audit shot joined the mission (docs/design/visual-qa-human-review.md,
  // "Realtime"): the mission page refreshes on worker:artifact, so thumbnails
  // stream in while the auditor works. qa/ uploads only; a thin payload with
  // no share token. The PUT may still be in flight when a client refetches,
  // which the thumbnail's expired-tile fallback covers.
  if (isAuditShot && artifactMissionId) {
    await triggerEvent(channels.mission(artifactMissionId), 'worker:artifact', {
      artifact: { id: artifact.id, workerId, missionId: artifactMissionId },
    });
  }

  // The credentialed download path (API key / session, scoped to the artifact's
  // tenant) is the only way to read this back until someone shares it.
  const downloadUrl = `${appBaseUrl()}/api/artifacts/${artifact.id}/download`;

  return NextResponse.json({
    artifactId: artifact.id,
    uploadUrl,
    downloadUrl,
    shareUrl: null,
    storageKey,
  });
}

/**
 * upload_artifact { artifactId, filename, mimeType, sizeBytes }: a new body for
 * a file artifact the caller may write (the same rule as PATCH
 * /api/artifacts/[artifactId]). It lands as the next revision once its bytes
 * are verified (lib/artifact-upload.ts); until then readers keep the current one.
 */
async function newRevision(
  account: TaskScopedAccount,
  artifactId: string,
  input: { filename: string; mimeType: string; sizeBytes: number; title?: string; metadata: Record<string, unknown> | null; attach: Array<AttachInput & { relation: unknown }> },
) {
  const artifact = await db.query.artifacts.findFirst({ where: sqlWhere(eq(artifacts.id, artifactId)), with: { worker: true } });
  const workspaceId = artifact?.workspaceId ?? artifact?.worker?.workspaceId ?? null;
  if (!artifact || !workspaceId || !taskScopeAllowsWorkspace(account, workspaceId)) {
    return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
  }
  if (account.taskScope) {
    const ownTaskArtifact = !!artifact.worker && artifact.worker.accountId === account.id && taskScopeAllowsWorker(account, artifact.worker);
    const ownMissionArtifact = !artifact.workerId && !artifact.initiativeId && await taskScopeAllowsMission(account, artifact.missionId);
    if (!ownTaskArtifact && !ownMissionArtifact) {
      return NextResponse.json({ error: "A task token may upload a revision only of its own task's or its own mission's artifacts" }, { status: 403 });
    }
  }
  if (artifact.worker?.accountId !== account.id && !(await verifyAccountWorkspaceAccess(account, workspaceId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const ws = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, workspaceId)), columns: { dataClass: true } });
  if (ws?.dataClass === 'sensitive') {
    return NextResponse.json({ error: 'Content upload is not permitted for sensitive workspaces' }, { status: 403 });
  }
  // The design check reads what the artifact will hold: its metadata with this upload's on top.
  if (input.metadata) {
    const designError = validateDesignMetadata({ ...(artifact.metadata ?? {}), ...input.metadata });
    if (designError) return NextResponse.json({ error: designError }, { status: 400 });
  }

  // The artifact is already verified, so its links are written now. A link
  // with no revision follows the current body, so it moves to this upload
  // once it lands; a pinned link stays where it is. Written first, so a
  // refused attach leaves no upload half-started.
  const links = [];
  for (const [i, a] of input.attach.entries()) {
    const linked = await linkArtifact(linkCallerOf(account), artifact.id, a);
    if (!linked.ok) return NextResponse.json({ error: `attach[${i}]: ${linked.error}` }, { status: linked.status });
    links.push(linked.link.id);
  }

  const started = await startFileRevision(
    artifact.id,
    { filename: input.filename, mimeType: input.mimeType, sizeBytes: input.sizeBytes, author: `account:${account.id}`, title: input.title ?? null, metadata: input.metadata },
    generateSizedUploadUrl,
  );
  if (!started.ok) return NextResponse.json({ error: started.error }, { status: started.status });

  return NextResponse.json({
    artifactId: artifact.id,
    revision: started.revision,
    uploadUrl: started.uploadUrl,
    downloadUrl: `${appBaseUrl()}/api/artifacts/${artifact.id}/download`,
    revisionDownloadUrl: `${appBaseUrl()}/api/artifacts/${artifact.id}/download?revision=${started.revision}`,
    shareUrl: null,
    storageKey: started.storageKey,
    links,
  });
}
