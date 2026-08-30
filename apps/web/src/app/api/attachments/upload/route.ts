import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { isStorageConfigured, generateSizedUploadUrl } from '@/lib/storage';
import { buildAttachmentKey } from '@/lib/storage-keys';
import { randomUUID } from 'crypto';

/**
 * Ceiling for a single attachment upload, enforced in the signature.
 *
 * 10MB is the limit this endpoint has always advertised; attachments are pasted
 * screenshots and small reference files, and the value is now bound into the
 * presigned PUT rather than only compared against a self-reported number.
 */
export const MAX_ATTACHMENT_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_FILES = 5;

export async function POST(req: NextRequest) {
  // Dual auth: API key or session
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);
  const user = apiAccount ? null : await getCurrentUser();

  if (!apiAccount && !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!isStorageConfigured()) {
    return NextResponse.json({ error: 'Storage not configured' }, { status: 503 });
  }

  const body = await req.json();
  const { workspaceId, files } = body as {
    workspaceId: string;
    files: Array<{ filename: string; mimeType: string; sizeBytes: number }>;
  };

  if (!workspaceId || !files || !Array.isArray(files) || files.length === 0) {
    return NextResponse.json({ error: 'workspaceId and files[] are required' }, { status: 400 });
  }

  if (files.length > MAX_FILES) {
    return NextResponse.json({ error: `Max ${MAX_FILES} files per upload` }, { status: 400 });
  }

  // The workspace id becomes the tenant segment of every key signed below, so
  // the caller must actually have access to it.
  const authorized = apiAccount
    ? await verifyAccountWorkspaceAccess(apiAccount.id, workspaceId)
    : !!(await verifyWorkspaceAccess(user!.id, workspaceId));

  if (!authorized) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 403 });
  }

  for (const file of files) {
    if (!file.mimeType) {
      return NextResponse.json({ error: `mimeType is required for each file` }, { status: 400 });
    }
    // The declared size is signed into each upload grant.
    if (typeof file.sizeBytes !== 'number' || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0) {
      return NextResponse.json(
        { error: 'sizeBytes must be a positive integer for each file' },
        { status: 400 }
      );
    }
    if (file.sizeBytes > MAX_ATTACHMENT_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `File "${file.filename}" exceeds ${MAX_ATTACHMENT_UPLOAD_BYTES / (1024 * 1024)}MB limit` },
        { status: 413 }
      );
    }
  }

  let uploads: Array<{
    storageKey: string;
    uploadUrl: string;
    filename: string;
    mimeType: string;
  }>;

  try {
    uploads = await Promise.all(
      files.map(async (file) => {
        const storageKey = buildAttachmentKey(workspaceId, randomUUID(), file.filename);
        const uploadUrl = await generateSizedUploadUrl(storageKey, file.mimeType, file.sizeBytes);
        return {
          storageKey,
          uploadUrl,
          // Echoed back verbatim for display; the object key uses a reduced form.
          filename: file.filename,
          mimeType: file.mimeType,
        };
      })
    );
  } catch {
    return NextResponse.json({ error: 'Unable to derive a storage key' }, { status: 400 });
  }

  return NextResponse.json({ uploads });
}
