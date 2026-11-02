/**
 * NFR-01.02 measurement: how long the dashboard takes to accept input after it is asked to open.
 * Started by scripts/measure-dashboard-open.ts, which sets SMOI_MEASURE_DASHBOARD to
 * "<opens>|<output file>". The time runs from the open request in the main process to the page
 * reporting that its first input is focused and ready (src/renderer/dashboard/App.tsx).
 *
 * The first open in a process is "cold" (a new renderer, nothing cached). Later opens in the same
 * process are "warm": the window is created again, but code and fonts are cached.
 */
import { app } from 'electron';
import { writeFileSync } from 'node:fs';
import type { Dashboard, OpenTiming } from './dashboard';

export function runMeasurement(dashboard: Dashboard, spec: string): void {
  const [countText, out] = spec.split('|');
  const count = Math.max(1, Number(countText) || 1);
  const samples: OpenTiming[] = [];
  const next = () => setTimeout(() => dashboard.open('home'), 500);
  dashboard.onOpenTiming((t) => {
    samples.push(t);
    dashboard.close();
    if (samples.length < count) next();
    else {
      writeFileSync(out, JSON.stringify({ samples }, null, 2));
      app.quit();
    }
  });
  // Let the frog and the other windows settle first, as on a normal start.
  setTimeout(() => dashboard.open('home'), 2000);
}
