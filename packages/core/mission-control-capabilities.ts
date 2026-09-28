export const MISSION_CONTROL_CAPABILITY_VERSION = 1;

export const MISSION_CONTROL_CAPABILITIES = [
  'startMode',
  'pacing',
  'executor',
] as const;

export type MissionControlCapability = (typeof MISSION_CONTROL_CAPABILITIES)[number];
