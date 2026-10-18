'use client';

import { useState } from 'react';
import { Select } from '@/components/ui/Select';
import { KERNEL_WINDOW_LABEL, KERNEL_WINDOWS, type KernelWindow } from '@/lib/kernel-windows';

const OPTIONS = (Object.keys(KERNEL_WINDOWS) as KernelWindow[]).map((w) => ({ value: w, label: KERNEL_WINDOW_LABEL[w] }));

/** The window picker of the kernel filters: posts `kwindow` with the surrounding GET form. */
export function WindowSelect({ value }: { value: KernelWindow }) {
  const [v, setV] = useState<KernelWindow>(value);
  return <Select id="kwindow" name="kwindow" value={v} onChange={setV} options={OPTIONS} aria-label="Window" size="sm" searchable={false} />;
}
