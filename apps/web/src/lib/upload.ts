/**
 * Client-side helper to upload images to R2 via presigned URLs.
 * Falls back gracefully — caller should catch errors and use inline base64 instead.
 */

interface PastedImage {
  filename: string;
  mimeType: string;
  data: string; // data URL
}

interface UploadedAttachment {
  storageKey: string;
  filename: string;
  mimeType: string;
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, base64] = dataUrl.split(',');
  const mimeMatch = header.match(/data:([^;]+)/);
  const mime = mimeMatch?.[1] || 'application/octet-stream';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

export async function uploadImagesToR2(
  workspaceId: string,
  images: PastedImage[],
): Promise<UploadedAttachment[]> {
  // Request presigned upload URLs from server
  const res = await fetch('/api/attachments/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceId,
      files: images.map((img) => ({
        filename: img.filename,
        mimeType: img.mimeType,
        sizeBytes: dataUrlToBlob(img.data).size,
      })),
    }),
  });

  if (!res.ok) {
    throw new Error(`Upload init failed: ${res.status}`);
  }

  const { uploads } = await res.json() as {
    uploads: Array<{ storageKey: string; uploadUrl: string; filename: string; mimeType: string }>;
  };

  // Upload each image directly to R2 via presigned PUT
  await Promise.all(
    uploads.map(async (upload, i) => {
      const blob = dataUrlToBlob(images[i].data);
      const putRes = await fetch(upload.uploadUrl, {
        method: 'PUT',
        body: blob,
        headers: { 'Content-Type': upload.mimeType },
      });
      if (!putRes.ok) {
        throw new Error(`R2 upload failed for ${upload.filename}: ${putRes.status}`);
      }
    })
  );

  return uploads.map((u) => ({
    storageKey: u.storageKey,
    filename: u.filename,
    mimeType: u.mimeType,
  }));
}
