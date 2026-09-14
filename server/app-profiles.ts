import { readFileSync, statSync } from 'node:fs';
import { validateAndFreezeProfile, type GatewayProfile } from '../packages/inference-gateway/src/profile.ts';

/** Loading a catalog entry cannot promote it to a reviewed execution route. */
export function loadApplicationGatewayProfiles(): readonly GatewayProfile[] {
  const path = process.env.MOTIVE_GATEWAY_PROFILES_FILE;
  if (!path) return [];
  if (statSync(path).size > 256 * 1024) throw new Error('Gateway profile bundle is too large.');
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(value) || value.length > 20) throw new Error('Gateway profile bundle must be an array of at most 20 reviewed profiles.');
  return value.map(item => {
    const profile = validateAndFreezeProfile(item);
    if (profile.status !== 'reviewed-live' || profile.evidence.kind !== 'gate-a-reviewed') throw new Error('The application only mounts reviewed live gateway profiles.');
    return profile;
  });
}
