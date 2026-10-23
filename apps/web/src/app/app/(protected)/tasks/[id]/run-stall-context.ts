'use client';

import { createContext } from 'react';
import type { RunStall } from '@/lib/run-stall';

/** The live view's stall reading, for the controls the page renders inside it. */
export const RunStallContext = createContext<RunStall | null>(null);
