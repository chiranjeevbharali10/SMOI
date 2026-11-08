import roster from 'virtual:smoi-roster';
import type { CompanionInfo } from '@desktop/shared/companions';

/** The companions, from the desktop app's manifests (validated at build time by vite.config.ts). */
export const companions: CompanionInfo[] = roster.companions;

export function companion(id: string): CompanionInfo {
  const c = companions.find((x) => x.id === id) ?? companions.find((x) => x.id === roster.defaultId);
  if (!c) throw new Error('No companions in the roster');
  return c;
}

export const smoi = companion('smoi');
