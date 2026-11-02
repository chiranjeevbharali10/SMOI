import type { UserSettings } from '../../shared/bridge';

const api = () => window.smoiDashboard;

/** The same settings as the tray menu; both write to one store in the main process. */
export function Settings({ settings }: { settings: UserSettings }) {
  const update = (patch: Partial<Omit<UserSettings, 'backendUrl'>>) => void api().updateSettings(patch);
  return (
    <>
      <h2>Settings</h2>
      <section className="card" aria-labelledby="h-motion">
        <h3 id="h-motion">Motion</h3>
        <label className="check">
          <input type="checkbox" checked={settings.reducedMotion}
                 onChange={(e) => update({ reducedMotion: e.target.checked })} />
          Reduced motion: still poses instead of animations, and no pop-in or rise
        </label>
        <p className="hint">SMOI also follows the Windows setting “Animation effects”.</p>
        <label className="check">
          <input type="checkbox" checked={settings.walking} disabled={settings.reducedMotion}
                 onChange={(e) => update({ walking: e.target.checked })} />
          Walk along the taskbar now and then
        </label>
        {settings.reducedMotion && <p className="hint">Walking is off while reduced motion is on.</p>}
      </section>
      <section className="card" aria-labelledby="h-general">
        <h3 id="h-general">General</h3>
        <label className="check">
          <input type="checkbox" checked={settings.startOnLogin}
                 onChange={(e) => update({ startOnLogin: e.target.checked })} />
          Start SMOI when I sign in to Windows
        </label>
        <label className="field" style={{ maxWidth: 360 }}>
          Fall asleep after this many minutes without input
          <select value={settings.sleepAfterMinutes} onChange={(e) => update({ sleepAfterMinutes: Number(e.target.value) })}>
            {[1, 2, 5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <p className="hint">Backend address: {settings.backendUrl}. Change it in settings.json in SMOI's app data folder.</p>
      </section>
    </>
  );
}
