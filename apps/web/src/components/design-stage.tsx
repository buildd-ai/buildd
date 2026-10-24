'use client';

/**
 * The mission page's current stage, for the design opened beneath it: the
 * design starts on the screen that matches the stage (Navigation R-3). Null
 * outside a mission page, where a design starts on its first screen.
 */
import { createContext, useContext } from 'react';
import type { DesignStage } from '@/lib/design-preview';

const MissionStageContext = createContext<DesignStage | null>(null);

export const MissionStageProvider = MissionStageContext.Provider;

export function useMissionStage(): DesignStage | null {
  return useContext(MissionStageContext);
}
