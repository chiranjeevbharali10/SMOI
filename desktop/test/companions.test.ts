import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { frameAt, totalDuration } from '../src/shared/animations';
import { accentFor, contrast, loadRoster, poseFor, poseName, pngSize, resolve, type RosterFiles } from '../src/shared/companions';
import { FrogStateMachine } from '../src/shared/stateMachine';
import { loadSettings, saveSettings } from '../src/main/settings';

const DIR = join(__dirname, '..', 'assets', 'companions');
const real = (p: string) => {
  try {
    return readFileSync(join(DIR, p));
  } catch {
    return null;
  }
};

/** The real roster, with some files replaced or removed. */
function files(overrides: Record<string, string | null> = {}): RosterFiles {
  return {
    text: (p) => (p in overrides ? overrides[p] : real(p)?.toString('utf8') ?? null),
    bytes: (p) => (p in overrides && overrides[p] === null ? null : real(p)),
  };
}

const manifest = (id: string) => JSON.parse(real(`${id}/manifest.json`)!.toString('utf8'));

describe('loading the roster', () => {
  it('reads every manifest: names, voices, timings, alert poses', () => {
    const r = loadRoster(files());
    expect(r.errors).toEqual([]);
    const nox = r.companions.find((c) => c.id === 'nox')!;
    expect(nox.name).toBe('NOX');
    expect(nox.creature).toBe('bat');
    expect(nox.lines).toHaveLength(3);
    expect(nox.poses.idle.frames).toHaveLength(12);
    expect(nox.poses.sleeping.row).toBe(2);
    expect(nox.alertPoses).toEqual({ attention: 'surprised', mail: 'thinking', tasks: 'annoyed' });
    // Timings come from the manifest, not from code.
    expect(nox.poses.surprised.frames).toEqual(manifest('nox').states.find((s: { state: string }) => s.state === 'surprised').durations_ms);
    expect(nox.poses.surprised.loop).toBe(false);
  });

  it('a sixth companion needs only a folder and a roster entry', () => {
    const six = { ...manifest('numi'), id: 'sixth', name: 'SIXTH' };
    const roster = JSON.parse(real('roster.json')!.toString('utf8'));
    const r = loadRoster({
      text: (p) => (p === 'roster.json' ? JSON.stringify({ ...roster, companions: [...roster.companions, 'sixth'] })
        : p === 'sixth/manifest.json' ? JSON.stringify(six) : real(p)?.toString('utf8') ?? null),
      bytes: (p) => real(p.replace(/^sixth\//, 'numi/')),
    });
    expect(r.errors).toEqual([]);
    expect(r.companions.map((c) => c.id)).toContain('sixth');
  });
});

describe('invalid manifests fall back to SMOI', () => {
  const broken: [string, Record<string, string | null>][] = [
    ['a missing manifest', { 'nox/manifest.json': null }],
    ['invalid JSON', { 'nox/manifest.json': '{ not json' }],
    ['a missing sheet', { 'nox/spritesheet.png': null }],
    ['a missing state', { 'nox/manifest.json': JSON.stringify({ ...manifest('nox'), states: manifest('nox').states.slice(1) }) }],
    ['durations that don’t match the frame count', {
      'nox/manifest.json': JSON.stringify({ ...manifest('nox'), states: manifest('nox').states.map((s: { durations_ms: number[] }, i: number) => (i === 0 ? { ...s, durations_ms: [100] } : s)) }),
    }],
    ['a row beyond the sheet', {
      'nox/manifest.json': JSON.stringify({ ...manifest('nox'), states: manifest('nox').states.map((s: object, i: number) => (i === 0 ? { ...s, row: 40 } : s)) }),
    }],
    ['an alert mapped to a pose it doesn’t have', { 'nox/manifest.json': JSON.stringify({ ...manifest('nox'), alert_poses: { attention: 'dancing', mail: 'thinking', tasks: 'annoyed' } }) }],
    ['an id that doesn’t match its folder', { 'nox/manifest.json': JSON.stringify({ ...manifest('nox'), id: 'yuzu' }) }],
  ];

  for (const [what, overrides] of broken) {
    it(`${what}: logged, left out, and choosing it gives SMOI`, () => {
      const r = loadRoster(files(overrides));
      expect(r.errors.map((e) => e.id)).toEqual(['nox']);
      expect(r.companions.map((c) => c.id)).not.toContain('nox');
      expect(r.companions.map((c) => c.id)).toContain('smoi');
      expect(resolve(r, 'nox')!.id).toBe('smoi');
    });
  }

  it('an unknown or missing choice gives the default', () => {
    const r = loadRoster(files());
    expect(resolve(r, 'nobody')!.id).toBe('smoi');
    expect(resolve(r, undefined)!.id).toBe('smoi');
  });

  it('a broken roster.json still loads SMOI', () => {
    const r = loadRoster(files({ 'roster.json': 'oops' }));
    expect(r.errors.map((e) => e.id)).toEqual(['roster']);
    expect(r.companions.map((c) => c.id)).toEqual(['smoi']);
  });

  it('reads PNG sizes from the header, and rejects non-PNGs', () => {
    expect(pngSize(real('wisp/spritesheet.png')!)).toEqual({ width: 768, height: 768 });
    expect(pngSize(new TextEncoder().encode('GIF89a not a png at all'))).toBeNull();
  });
});

describe('frame timing', () => {
  const nox = loadRoster(files()).companions.find((c) => c.id === 'nox')!;

  it('follows the per-frame durations and loops', () => {
    const idle = nox.poses.idle;
    expect(frameAt(idle, 0).index).toBe(0);
    expect(frameAt(idle, idle.frames[0] - 1).index).toBe(0);
    expect(frameAt(idle, idle.frames[0]).index).toBe(1);
    expect(frameAt(idle, totalDuration(idle)).index).toBe(0);
  });

  it('a one-shot pose holds its last frame when finished', () => {
    const s = nox.poses.surprised;
    const total = totalDuration(s);
    expect(frameAt(s, total - 1)).toEqual({ index: s.frames.length - 1, finished: false });
    expect(frameAt(s, total + 10_000)).toEqual({ index: s.frames.length - 1, finished: true });
  });
});

describe('one-shot return and held alerts', () => {
  it('surprised plays once, then returns to the previous state', () => {
    const m = new FrogStateMachine();
    m.set('working', true, 0);
    m.react('surprised', 0);
    expect(m.state).toBe('surprised');
    m.animationFinished('surprised', 1000);
    expect(m.state).toBe('working');
    m.set('working', false, 1000);
    expect(m.state).toBe('idle');
  });

  it('attention maps to the one-shot surprised pose for the new companions, and stays until acknowledged', () => {
    const r = loadRoster(files());
    const numi = r.companions.find((c) => c.id === 'numi')!;
    const smoi = r.companions.find((c) => c.id === 'smoi')!;
    expect(poseName(numi, 'attention')).toBe('surprised');
    expect(poseFor(numi, 'attention').loop).toBe(false);
    expect(poseName(numi, 'mail')).toBe('thinking');
    expect(poseName(numi, 'tasks')).toBe('annoyed');
    expect(poseName(smoi, 'attention')).toBe('attention');
    expect(poseName(numi, 'happy')).toBe('happy');

    const m = new FrogStateMachine();
    m.set('attention', true, 0);
    // The renderer reports the one-shot finished; the alert must not drop back to idle.
    m.animationFinished('attention', 1000);
    m.tick(60_000);
    expect(m.state).toBe('attention');
    m.set('attention', false, 60_000);
    expect(m.state).toBe('idle');
  });
});

describe('panel accent', () => {
  it('uses the first palette colour that keeps charcoal text readable', () => {
    const r = loadRoster(files());
    for (const c of r.companions) {
      const a = accentFor(c.palette);
      expect(a, c.id).not.toBeNull();
      expect(contrast(a!, '#514B50'), c.id).toBeGreaterThanOrEqual(4.5);
    }
    // NOX's first colour is too dark for charcoal text, so the next readable one is used.
    expect(accentFor(r.companions.find((c) => c.id === 'nox')!.palette)).toBe('#D9CDEC');
    expect(accentFor(r.companions.find((c) => c.id === 'smoi')!.palette)).toBe('#B8DDB1');
  });
});

describe('the chosen companion is remembered', () => {
  it('is saved and restored, and existing settings files default to SMOI', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smoi-settings-'));
    const file = join(dir, 'settings.json');
    const s = loadSettings(file);
    expect(s.companion).toBe('smoi');
    saveSettings({ ...s, companion: 'yuzu' }, file);
    expect(loadSettings(file).companion).toBe('yuzu');

    // A settings file from before companions existed.
    writeFileSync(file, JSON.stringify({ walking: false }));
    expect(loadSettings(file)).toMatchObject({ companion: 'smoi', walking: false });
    // A hand-edited, malformed value.
    writeFileSync(file, JSON.stringify({ companion: '../../evil' }));
    expect(loadSettings(file).companion).toBe('smoi');
  });
});
