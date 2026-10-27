export async function diffAnchor(filePath: string): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    return '';
  }
  const encoder = new TextEncoder();
  const data = encoder.encode(filePath);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hash = Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `#diff-${hash}`;
}

export function diffAnchorSync(filePath: string): string | null {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) {
    return null;
  }
  const { createHash } = require('crypto');
  const hash = createHash('sha256').update(filePath).digest('hex');
  return `#diff-${hash}`;
}
