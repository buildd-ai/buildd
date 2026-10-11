'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import Sheet, { type SheetProps } from '@/components/ui/Sheet';
import { hrefWithout } from '@/lib/url-sheet';

/** Close a sheet that a query param opened: replace the URL without `keys`. */
export function useCloseUrlSheet(keys: readonly string[]): () => void {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const joined = keys.join(',');
  return useCallback(
    () => router.replace(hrefWithout(pathname, searchParams.toString(), joined.split(',')), { scroll: false }),
    [router, pathname, searchParams, joined],
  );
}

/**
 * `Sheet`, open while the page that renders it says so (the server reads the
 * param), closed by dropping `keys` from the URL. For a job that ends in one
 * action, started from the page behind it.
 */
export default function UrlSheet({
  keys,
  ...props
}: Omit<SheetProps, 'open' | 'onClose'> & { keys: readonly string[] }) {
  const close = useCloseUrlSheet(keys);
  return <Sheet open onClose={close} trapFocus {...props} />;
}
