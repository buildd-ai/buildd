'use client';

import { useState } from 'react';
import { Select, type SelectOption } from '@/components/ui/Select';

/** A form-posting select for the comparison filters. */
export function FilterSelect({ name, label, options, initial }: {
  name: string; label: string; options: readonly SelectOption<string>[]; initial: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div className="text-xs text-text-muted flex flex-col gap-1">
      <span id={`fs-${name}`}>{label}</span>
      <Select name={name} value={value} onChange={setValue} options={options} aria-labelledby={`fs-${name}`} />
    </div>
  );
}
