/**
 * Reads the companion roster from disk for the main process (shared/companions.ts does the
 * validation). Problems are logged, never thrown: a broken companion is left out, and the app
 * falls back to the roster default (SMOI).
 */
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { loadRoster, type Roster } from '../shared/companions';

export function readRoster(dir: string, log: (m: string) => void = console.error): Roster {
  const root = resolve(dir);
  const inside = (p: string) => {
    const full = resolve(join(root, p));
    return full.startsWith(root + sep) ? full : null;
  };
  const roster = loadRoster({
    text: (p) => {
      const f = inside(p);
      try {
        return f ? readFileSync(f, 'utf8') : null;
      } catch {
        return null;
      }
    },
    bytes: (p) => {
      const f = inside(p);
      try {
        return f ? readFileSync(f) : null;
      } catch {
        return null;
      }
    },
  });
  for (const e of roster.errors) log(`[companions] ${e.id}: ${e.reason}`);
  return roster;
}
