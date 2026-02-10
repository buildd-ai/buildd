import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { isStorageConfigured, generateUploadUrl } from '@/lib/storage';
import { randomUUID } from 'crypto';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
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

  for (const file of files) {
    if (!file.mimeType?.startsWith('image/')) {
      return NextResponse.json({ error: `Only image files are allowed (got ${file.mimeType})` }, { status: 400 });
    }
    if (file.sizeBytes > MAX_FILE_SIZE) {
      return NextResponse.json({ error: `File "${file.filename}" exceeds 10MB limit` }, { status: 400 });
    }
  }

  const uploads = await Promise.all(
    files.map(async (file) => {
      const uuid = randomUUID();
      const storageKey = `attachments/${workspaceId}/${uuid}/${file.filename}`;
      const uploadUrl = await generateUploadUrl(storageKey, file.mimeType);
      return {
        storageKey,
        uploadUrl,
        filename: file.filename,
        mimeType: file.mimeType,
      };
    })
  );

  return NextResponse.json({ uploads });
}
