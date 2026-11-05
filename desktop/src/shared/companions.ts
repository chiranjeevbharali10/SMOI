/**
 * The companion roster: SMOI the frog plus any others in assets/companions/. Everything about a
 * companion (name, voice, palette, poses, timings, walking speed) comes from its folder:
 *
 *   assets/companions/roster.json          { "default": "smoi", "companions": ["smoi", ...] }
 *   assets/companions/<id>/manifest.json   name, creature, personality, lines, palette, states...
 *   assets/companions/<id>/spritesheet.png 64x64 cells, one state per row, rows left-aligned
 *
 * Adding a companion needs only a new folder and a roster entry. A manifest or sheet that is
 * missing or invalid is logged and that companion is left out; selecting it falls back to the
 * roster default (SMOI). Nothing here throws at the caller.
 *
 * Pure: the caller passes a file reader, so the main process reads from disk and tests read
 * fixtures. Tested in test/companions.test.ts.
 */
import { ALERT_STATES, CELL, CORE_STATES, type AlertState, type Animation, type FrogState } from './animations';

/** One drawable pose: a row of a sheet, with its timing. */
export interface Pose extends Animation {
  /** Sheet path relative to the companion's folder. */
  sheet: string;
  row: number;
  /** Drawn for SMOI, not yet in the design board. */
  draft: boolean;
}

export interface Companion {
  id: string;
  name: string;
  creature: string;
  tagline: string;
  personality: string;
  /** Sample lines in its voice (manifest "lines"). */
  lines: string[];
  palette: Record<string, string>;
  notes: string;
  /** Pixels per walking step (the walk timer moves this far each tick). */
  walkSpeed: number;
  /** Which pose each alert shows. */
  alertPoses: Record<AlertState, string>;
  /** Core states plus any extra poses. */
  poses: Record<string, Pose>;
  /**
   * Optional lines in its own voice for app events, as templates with {placeholders}. Missing
   * events fall back to the shared lines (shared/personality.ts).
   */
  eventLines: Record<string, string>;
}

/** What the main process sends to the frog window and the dashboard. */
export type CompanionInfo = Omit<Companion, 'notes'> & { accent: string | null };

export interface Roster {
  defaultId: string;
  /** Valid companions in roster order. */
  companions: Companion[];
  /** Why each left-out companion was rejected. */
  errors: { id: string; reason: string }[];
}

export class ManifestError extends Error {}

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const MAX_FRAMES = 64;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, what: string, max = 500): string => {
  if (typeof v !== 'string' || v.trim() === '' || v.length > max) throw new ManifestError(`${what} must be a non-empty string`);
  return v;
};

/** A sheet's pixel size, from its PNG header, or null if the file isn't a PNG. */
export type SheetSize = { width: number; height: number } | null;

export function pngSize(bytes: Uint8Array): SheetSize {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return null;
  const u32 = (o: number) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  return { width: u32(16), height: u32(20) };
}

function pose(v: unknown, what: string, sheet: string, size: SheetSize, draft: boolean): Pose {
  if (!isObj(v)) throw new ManifestError(`${what} is not an object`);
  const row = v.row;
  const frames = v.frames;
  const durations = v.durations_ms;
  if (!Number.isInteger(row) || (row as number) < 0) throw new ManifestError(`${what}: bad row`);
  if (!Number.isInteger(frames) || (frames as number) < 1 || (frames as number) > MAX_FRAMES) throw new ManifestError(`${what}: bad frame count`);
  if (!Array.isArray(durations) || durations.length !== frames) throw new ManifestError(`${what}: durations_ms must have one entry per frame`);
  if (!durations.every((d) => Number.isInteger(d) && d >= 16 && d <= 10_000)) throw new ManifestError(`${what}: each duration must be 16 to 10000 ms`);
  if (typeof v.loop !== 'boolean') throw new ManifestError(`${what}: loop must be true or false`);
  if (!size) throw new ManifestError(`${what}: ${sheet} is missing or not a PNG`);
  if (((row as number) + 1) * CELL > size.height || (frames as number) * CELL > size.width) {
    throw new ManifestError(`${what}: row ${row} with ${frames} frames doesn't fit ${sheet} (${size.width}x${size.height})`);
  }
  return { sheet, row: row as number, frames: durations as number[], loop: v.loop, draft };
}

/**
 * Validates one manifest.
 *
 * @param sheetSize size of a sheet file in the companion's folder, or null if missing
 * @throws ManifestError with the reason
 */
export function parseManifest(json: unknown, id: string, sheetSize: (file: string) => SheetSize): Companion {
  if (!isObj(json)) throw new ManifestError('manifest is not a JSON object');
  if (json.id !== id) throw new ManifestError(`manifest id ${JSON.stringify(json.id)} doesn't match folder ${id}`);
  const cell = json.cell;
  if (!isObj(cell) || cell.width !== CELL || cell.height !== CELL) throw new ManifestError(`cells must be ${CELL}x${CELL}`);
  if (!Array.isArray(json.states)) throw new ManifestError('states is missing');

  const sheet = 'spritesheet.png';
  const size = sheetSize(sheet);
  const poses: Record<string, Pose> = {};
  for (const s of json.states) {
    if (!isObj(s) || typeof s.state !== 'string') throw new ManifestError('a state has no name');
    poses[s.state] = pose(s, `state ${s.state}`, sheet, size, false);
  }
  for (const state of CORE_STATES) if (!poses[state]) throw new ManifestError(`state ${state} is missing`);

  for (const extra of Array.isArray(json.extra_states) ? json.extra_states : []) {
    if (!isObj(extra) || typeof extra.state !== 'string' || !ID.test(extra.state)) throw new ManifestError('an extra state has no valid name');
    const file = str(extra.sheet, `extra state ${extra.state} sheet`, 200);
    if (file.includes('..') || file.startsWith('/') || file.includes('\\')) throw new ManifestError(`extra state ${extra.state}: sheet must be inside the folder`);
    poses[extra.state] = pose(extra, `extra state ${extra.state}`, file, sheetSize(file), extra.draft === true);
  }

  const alertPoses = {} as Record<AlertState, string>;
  const ap = isObj(json.alert_poses) ? json.alert_poses : {};
  for (const alert of ALERT_STATES) {
    const target = ap[alert];
    if (typeof target !== 'string' || !poses[target]) throw new ManifestError(`alert_poses.${alert} must name one of its poses`);
    alertPoses[alert] = target;
  }

  const speed = json.walk_speed_px;
  if (!Number.isInteger(speed) || (speed as number) < 1 || (speed as number) > 8) throw new ManifestError('walk_speed_px must be a whole number from 1 to 8');

  const palette: Record<string, string> = {};
  if (isObj(json.palette)) for (const [k, v] of Object.entries(json.palette)) if (typeof v === 'string' && HEX.test(v)) palette[k] = v;

  const eventLines: Record<string, string> = {};
  if (isObj(json.event_lines)) {
    for (const [k, v] of Object.entries(json.event_lines)) if (typeof v === 'string' && v.trim() && v.length <= 300) eventLines[k] = v;
  }

  return {
    id,
    name: str(json.name, 'name', 24),
    creature: str(json.creature, 'creature', 40),
    tagline: str(json.tagline, 'tagline', 200),
    personality: str(json.personality, 'personality', 200),
    lines: Array.isArray(json.lines) ? json.lines.filter((l): l is string => typeof l === 'string' && l.length > 0 && l.length <= 200) : [],
    palette,
    notes: typeof json.notes === 'string' ? json.notes : '',
    walkSpeed: speed as number,
    alertPoses,
    poses,
    eventLines,
  };
}

export interface RosterFiles {
  /** Text of a file under assets/companions/, or null if missing. */
  text(path: string): string | null;
  /** Bytes of a file under assets/companions/, or null if missing. */
  bytes(path: string): Uint8Array | null;
}

/** Loads and validates the roster and every manifest. Never throws; problems go to `errors`. */
export function loadRoster(files: RosterFiles): Roster {
  const errors: Roster['errors'] = [];
  let ids: string[] = [];
  let defaultId = 'smoi';
  try {
    const roster = JSON.parse(files.text('roster.json') ?? 'null');
    if (!isObj(roster) || !Array.isArray(roster.companions)) throw new Error('roster.json is missing or invalid');
    ids = roster.companions.filter((x): x is string => typeof x === 'string' && ID.test(x));
    if (typeof roster.default === 'string' && ID.test(roster.default)) defaultId = roster.default;
  } catch (e) {
    errors.push({ id: 'roster', reason: e instanceof Error ? e.message : String(e) });
    ids = ['smoi'];
  }
  const companions: Companion[] = [];
  for (const id of [...new Set(ids)]) {
    try {
      const text = files.text(`${id}/manifest.json`);
      if (text === null) throw new ManifestError('manifest.json is missing');
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ManifestError('manifest.json is not valid JSON');
      }
      companions.push(parseManifest(json, id, (file) => {
        const b = files.bytes(`${id}/${file}`);
        return b ? pngSize(b) : null;
      }));
    } catch (e) {
      errors.push({ id, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  if (!companions.some((c) => c.id === defaultId) && companions.length > 0) {
    errors.push({ id: defaultId, reason: `default companion ${defaultId} is not available; using ${companions[0].id}` });
    defaultId = companions[0].id;
  }
  return { defaultId, companions, errors };
}

/** The companion to show: the chosen one if it's valid, otherwise the default. */
export function resolve(roster: Roster, chosen: string | null | undefined): Companion | null {
  return roster.companions.find((c) => c.id === chosen) ?? roster.companions.find((c) => c.id === roster.defaultId) ?? null;
}

/** The pose name a state shows for this companion: alerts go through its alert_poses map. */
export function poseName(c: Pick<Companion, 'alertPoses'>, state: FrogState): string {
  return (ALERT_STATES as readonly string[]).includes(state) ? c.alertPoses[state as AlertState] : state;
}

export function poseFor(c: Pick<Companion, 'alertPoses' | 'poses'>, state: FrogState): Pose {
  return c.poses[poseName(c, state)] ?? c.poses.idle;
}

// ---- panel accent colour ------------------------------------------------------------------------

const CHARCOAL = '#514B50';

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The panel header colour: the first palette colour that keeps the header's charcoal text readable
 * (WCAG AA, 4.5:1), or null to keep the design's default.
 */
export function accentFor(palette: Record<string, string>): string | null {
  for (const hex of Object.values(palette)) {
    if (hex.toUpperCase() !== CHARCOAL && contrast(hex, CHARCOAL) >= 4.5) return hex;
  }
  return null;
}

export function info(c: Companion): CompanionInfo {
  const { notes: _notes, ...rest } = c;
  return { ...rest, accent: accentFor(c.palette) };
}
