'use client';

/** The waiting line of a queued task whose backend has no credential (lib/credential-block). */
import Link from 'next/link';
import { credentialBlockCopy, type CredentialBlock } from '@/lib/credential-block-copy';

export default function CredentialBlockedNotice({ block }: { block: CredentialBlock }) {
  const copy = credentialBlockCopy(block);
  return (
    <div data-testid="credential-blocked" data-route={block.route} role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 border border-border-default p-4 font-mono text-meta">
      <span className="text-text-secondary">{copy.line}</span>
      <Link href={copy.href} className="underline text-text-primary hover:no-underline">{copy.cta}</Link>
    </div>
  );
}
