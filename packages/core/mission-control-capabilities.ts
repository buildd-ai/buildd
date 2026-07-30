export const MISSION_CONTROL_CAPABILITY_VERSION = 1;

export const MISSION_CONTROL_CAPABILITIES = [
  'startMode',
  'pacing',
] as const;

export type MissionControlCapability = (typeof MISSION_CONTROL_CAPABILITIES)[number];
