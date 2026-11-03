/**
 * Runs the desktop check (src/main/e2e.ts) against the real app.
 *
 *   npm run build
 *   SMOI_E2E_EMAIL=... SMOI_E2E_PASSWORD=... npx tsx scripts/desktop-check.ts [output dir]
 *
 * Passes, in order (choose with SMOI_CHECK_SCALES, for example "native,1.25"):
 * - native: the displays' real Windows scaling. Also moves the frog to every other connected
 *   display and checks again there, and asks a question from the frog if a test account is given.
 * - 1, 1.25, 1.5: scaling forced with Chromium's --force-device-scale-factor, so 100%, 125% and
 *   150% are covered whatever this machine's displays use.
 *
 * It uses a throwaway profile, never your own settings or sign-in, and opens its own test window
 * as "another app". It moves the mouse and types: don't touch the mouse or keyboard while it runs.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(DESKTOP, 'test-results', 'desktop-check'));
const question = process.env.SMOI_E2E_QUESTION ?? 'Where does the natterjack toad live?';
const passes = (process.env.SMOI_CHECK_SCALES ?? 'native,1,1.25,1.5').split(',');
mkdirSync(out, { recursive: true });

const rows: string[] = [];
let failures = 0;
for (const pass of passes) {
  const label = pass === 'native' ? 'native' : `forced-${Math.round(Number(pass) * 100)}`;
  console.log(`\n=== ${label} ===`);
  const userData = mkdtempSync(join(tmpdir(), 'smoi-check-'));
  const args = pass === 'native' ? ['.'] : ['.', `--force-device-scale-factor=${pass}`];
  const r = spawnSync(electron as unknown as string, args, {
    cwd: DESKTOP,
    stdio: 'inherit',
    timeout: 900_000,
    env: {
      ...process.env,
      SMOI_TEST_USERDATA: userData,
      SMOI_E2E_OUT: out,
      SMOI_E2E_LABEL: label,
      SMOI_E2E_QUESTION: pass === 'native' && process.env.SMOI_E2E_EMAIL ? question : '',
    },
  });
  rmSync(userData, { recursive: true, force: true });
  const file = join(out, `results-${label}.json`);
  if (r.status !== 0 || !existsSync(file)) {
    failures++;
    rows.push(`| ${label} | The app exited before writing results (exit ${r.status}) | FAIL | |`);
    continue;
  }
  const { steps } = JSON.parse(readFileSync(file, 'utf8')) as { steps: { name: string; pass: boolean | null; detail: string }[] };
  for (const s of steps) {
    if (s.pass === false) failures++;
    const detail = s.detail.replace(/\|/g, '/').replace(/\s+/g, ' ');
    rows.push(`| ${label} | ${s.name} | ${s.pass === null ? 'SKIP' : s.pass ? 'PASS' : 'FAIL'} | ${detail} |`);
  }
}

const report = ['| Pass | Check | Result | Detail |', '| --- | --- | --- | --- |', ...rows].join('\n');
writeFileSync(join(out, 'summary.md'), report + '\n');
console.log(`\n${report}\n\n${failures} failed. Results in ${out}`);
process.exit(failures ? 1 : 0);
