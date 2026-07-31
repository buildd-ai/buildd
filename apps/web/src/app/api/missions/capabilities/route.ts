import { NextResponse } from 'next/server';
import {
  MISSION_CONTROL_CAPABILITIES,
  MISSION_CONTROL_CAPABILITY_VERSION,
} from '@buildd/core/mission-control-capabilities';

export async function GET() {
  return NextResponse.json({
    version: MISSION_CONTROL_CAPABILITY_VERSION,
    capabilities: MISSION_CONTROL_CAPABILITIES,
  });
}
