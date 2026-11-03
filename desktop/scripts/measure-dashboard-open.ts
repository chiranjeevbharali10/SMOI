/**
 * NFR-01.02: "The dashboard shall accept input within 2 seconds of being opened (target, p95)."
 *
 *   npm run build
 *   [SMOI_E2E_EMAIL=... SMOI_E2E_PASSWORD=...] npx tsx scripts/measure-dashboard-open.ts [launches] [opens per launch]
 *
 * Starts the app `launches` times (default 10), each with a fresh throwaway profile. In each
 * launch the dashboard is opened `opens per launch` times (default 11), closing it in between:
 * - the first open in a launch is **cold** (first dashboard renderer since the app started);
 * - the others are **warm** (the window is created again, but code and fonts are cached).
 * Each time is measured in the main process, from the open request until the page reports its
 * first screen drawn and ready for input (src/main/measure.ts, src/renderer/dashboard/App.tsx).
 *
 * With a test account the dashboard opens signed in (the Home screen); without one it opens on
 * the sign-in form. The result file in desktop/perf-results/ records which.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const launches = Number(process.argv[2] ?? 10);
const opens = Number(process.argv[3] ?? 11);
const signedIn = Boolean(process.env.SMOI_E2E_EMAIL && process.env.SMOI_E2E_PASSWORD);

const cold: number[] = [];
const warm: number[] = [];
for (let i = 0; i < launches; i++) {
  const userData = mkdtempSync(join(tmpdir(), 'smoi-measure-'));
  const out = join(userData, 'timings.json');
  const r = spawnSync(electron as unknown as string, ['.'], {
    cwd: DESKTOP, stdio: 'ignore', timeout: 180_000,
    env: { ...process.env, SMOI_TEST_USERDATA: userData, SMOI_MEASURE_DASHBOARD: `${opens}|${out}` },
  });
  try {
    const { samples } = JSON.parse(readFileSync(out, 'utf8')) as { samples: { cold: boolean; ms: number }[] };
    for (const s of samples) (s.cold ? cold : warm).push(Math.round(s.ms * 10) / 10);
    console.log(`launch ${i + 1}: cold ${samples.find((s) => s.cold)?.ms.toFixed(0)} ms, ${samples.length - 1} warm`);
  } catch {
    console.error(`launch ${i + 1} produced no timings (exit ${r.status})`);
  }
  rmSync(userData, { recursive: true, force: true });
}

/** Nearest-rank percentile. */
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)] : NaN;
};
const summary = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), max: Math.max(...xs) });

const result = {
  script: 'desktop/scripts/measure-dashboard-open.ts',
  measuredAt: new Date().toISOString(),
  screen: signedIn ? 'Home (signed in)' : 'sign-in form (signed out)',
  build: 'production renderer build (npm run build), unpackaged Electron',
  machine: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryGiB: Math.round(totalmem() / 2 ** 30), windows: release() },
  cold: summary(cold),
  warm: summary(warm),
  samples: { cold, warm },
};
const dir = join(DESKTOP, 'perf-results');
mkdirSync(dir, { recursive: true });
const file = join(dir, `dashboard-open_${result.measuredAt.replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '_')}.json`);
writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ cold: result.cold, warm: result.warm }, null, 2));
console.log(`Saved ${file}`);
