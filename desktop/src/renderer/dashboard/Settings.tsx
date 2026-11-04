import { useState, type KeyboardEvent } from 'react';
import type { GoogleView, SettingsPatch, UserSettings } from '../../shared/bridge';
import { GoogleSettings } from './GoogleSettings';
import { CATEGORIES, type Level, type NotificationSettings } from '../../shared/notify';
import { PRESETS, type Personality, type PresetId } from '../../shared/personality';

const api = () => window.smoiDashboard;

const SLIDERS: { key: keyof Personality; label: string; low: string; high: string }[] = [
  { key: 'humour', label: 'Humour', low: 'serious', high: 'silly' },
  { key: 'sarcasm', label: 'Sarcasm', low: 'none', high: 'lots' },
  { key: 'friendliness', label: 'Friendliness', low: 'reserved', high: 'gushing' },
  { key: 'strictness', label: 'Reminder strictness', low: 'easy-going', high: 'insistent' },
];

/** "Control+Alt+J" for display: "Ctrl+Alt+J". */
const showKeys = (accel: string) => accel.replace(/Control/g, 'Ctrl');

/** A key press as an Electron accelerator, or null if it isn't a usable shortcut (it needs a modifier). */
function accelerator(e: KeyboardEvent): string | null {
  const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean) as string[];
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) key = e.code;
  else if (e.code === 'Space') key = 'Space';
  return key && mods.length > 0 ? [...mods, key].join('+') : null;
}

/** The same settings as the tray menu, plus voice, personality and notifications. */
export function Settings({ settings, google }: { settings: UserSettings; google: GoogleView | null }) {
  const update = (patch: SettingsPatch) => void api().updateSettings(patch);
  const [recording, setRecording] = useState(false);
  const [keyHint, setKeyHint] = useState<string | null>(null);
  const p = settings.personality;
  const n = settings.notifications;
  const preset = (Object.entries(PRESETS) as [PresetId, (typeof PRESETS)[PresetId]][])
    .find(([, v]) => SLIDERS.every((s) => v.values[s.key] === p[s.key]))?.[0] ?? 'custom';
  const notify = (patch: Partial<NotificationSettings>) => update({ notifications: { ...n, ...patch } });

  const onShortcutKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    if (e.key === 'Escape') {
      setRecording(false);
      setKeyHint(null);
      return;
    }
    if (['Control', 'Alt', 'Shift', 'Meta', 'Tab'].includes(e.key)) return;
    e.preventDefault();
    const accel = accelerator(e);
    if (!accel) {
      setKeyHint('Use Ctrl, Alt or Shift together with a letter, a number or a function key.');
      return;
    }
    setRecording(false);
    setKeyHint(null);
    update({ shortcut: accel });
  };

  return (
    <>
      <h2>Settings</h2>
      <section className="card" aria-labelledby="h-voice">
        <h3 id="h-voice">Voice</h3>
        <label className="check">
          <input type="checkbox" checked={settings.voiceEnabled} onChange={(e) => update({ voiceEnabled: e.target.checked })} />
          Voice commands: SMOI listens after you press the shortcut, and only then
        </label>
        <p className="hint">
          While SMOI listens, the frog shows its listening pose with a microphone. Esc or the shortcut again stops it.
          Speech is turned into text by the SMOI backend (a local speech model) and isn't kept.
        </p>
        <div className="row">
          <span>Shortcut: <strong>{showKeys(settings.shortcut)}</strong></span>
          <button type="button" className="btn small" disabled={!settings.voiceEnabled}
                  onClick={() => { setRecording(true); setKeyHint('Press the new shortcut now, or Esc to keep the current one.'); }}
                  onKeyDown={onShortcutKey} onBlur={() => { setRecording(false); setKeyHint(null); }}
                  aria-describedby="shortcut-hint">
            {recording ? 'Press keys…' : 'Change'}
          </button>
        </div>
        <p id="shortcut-hint" className="hint" role="status">{keyHint ?? ''}</p>
        {settings.voiceEnabled && settings.shortcutError && (
          <div className="banner error" role="alert"><span>{settings.shortcutError}</span></div>
        )}
      </section>

      <section className="card" aria-labelledby="h-personality">
        <h3 id="h-personality">Personality</h3>
        <label className="field" style={{ maxWidth: 360 }}>
          Style
          <select value={preset} onChange={(e) => {
            const v = e.target.value as PresetId | 'custom';
            if (v !== 'custom') update({ personality: PRESETS[v].values });
          }}>
            {Object.entries(PRESETS).map(([id, v]) => <option key={id} value={id}>{v.label}</option>)}
            {preset === 'custom' && <option value="custom">Custom</option>}
          </select>
        </label>
        {SLIDERS.map((s) => (
          <label key={s.key} className="field slider">
            {s.label}: {p[s.key]} of 4
            <input type="range" min={0} max={4} step={1} value={p[s.key]}
                   aria-valuetext={`${p[s.key]} of 4`}
                   onChange={(e) => update({ personality: { ...p, [s.key]: Number(e.target.value) } })} />
            <span className="hint slider-ends"><span>{s.low}</span><span>{s.high}</span></span>
          </label>
        ))}
        <p className="hint">
          Changes how SMOI words its speech bubbles. It never changes facts, and error messages are always plain.
          Strictness 2 or more keeps reminders on screen until you dismiss them; at 0, SMOI doesn't mention overdue tasks.
        </p>
      </section>

      <GoogleSettings google={google} />

      <section className="card" aria-labelledby="h-claude">
        <h3 id="h-claude">Claude Code</h3>
        <label className="check">
          <input type="checkbox" checked={settings.claudeCode.enabled}
                 onChange={(e) => update({ claudeCode: { ...settings.claudeCode, enabled: e.target.checked } })} />
          Tell me when Claude Code finishes a long run or needs my permission
        </label>
        <label className="field" style={{ maxWidth: 360 }}>
          Celebrate runs of at least (minutes)
          <input type="number" min={0} max={240} step={1} value={settings.claudeCode.celebrateAfterMinutes}
                 disabled={!settings.claudeCode.enabled}
                 onChange={(e) => {
                   const m = Number(e.target.value);
                   if (Number.isInteger(m)) update({ claudeCode: { ...settings.claudeCode, celebrateAfterMinutes: m } });
                 }} />
        </label>
        <p className="hint" role="status">
          {settings.claudeHooks.listening
            ? `Listening for Claude Code hooks on 127.0.0.1:${settings.claudeHooks.port}.`
            : `Not listening: ${settings.claudeHooks.problem ?? 'unknown reason.'}`}
          {' '}SMOI only learns that a run started, finished or is waiting. It never sees your prompts or files.
          Quiet hours and the categories below apply.
        </p>
      </section>

      <section className="card" aria-labelledby="h-notifications">
        <h3 id="h-notifications">Notifications</h3>
        <fieldset className="days">
          <legend>Show them as</legend>
          <label className="check">
            <input type="radio" name="channel" checked={n.channel === 'bubble'} onChange={() => notify({ channel: 'bubble' })} />
            SMOI's speech bubbles
          </label>
          <label className="check">
            <input type="radio" name="channel" checked={n.channel === 'native'} onChange={() => notify({ channel: 'native' })} />
            Windows notifications
          </label>
        </fieldset>
        <table className="settings-table">
          <thead><tr><th scope="col">Category</th><th scope="col">On</th><th scope="col">Priority</th></tr></thead>
          <tbody>
            {CATEGORIES.map((c) => (
              <tr key={c.id}>
                <th scope="row">{c.label}</th>
                <td>
                  <input type="checkbox" aria-label={`${c.label} on`} checked={n.categories[c.id].enabled}
                         onChange={(e) => notify({ categories: { ...n.categories, [c.id]: { ...n.categories[c.id], enabled: e.target.checked } } })} />
                </td>
                <td>
                  <select aria-label={`${c.label} priority`} value={n.categories[c.id].priority}
                          onChange={(e) => notify({ categories: { ...n.categories, [c.id]: { ...n.categories[c.id], priority: e.target.value as Level } } })}>
                    <option value="low">Low</option>
                    <option value="normal">Normal</option>
                    <option value="high">High (always shown)</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <label className="check">
          <input type="checkbox" checked={n.quietHours.enabled}
                 onChange={(e) => notify({ quietHours: { ...n.quietHours, enabled: e.target.checked } })} />
          Quiet hours: hold everything except high priority
        </label>
        <div className="row">
          <label className="field">From
            <input type="time" value={n.quietHours.start} disabled={!n.quietHours.enabled}
                   onChange={(e) => e.target.value && notify({ quietHours: { ...n.quietHours, start: e.target.value } })} />
          </label>
          <label className="field">To
            <input type="time" value={n.quietHours.end} disabled={!n.quietHours.enabled}
                   onChange={(e) => e.target.value && notify({ quietHours: { ...n.quietHours, end: e.target.value } })} />
          </label>
        </div>
        <label className="field" style={{ maxWidth: 360 }}>
          Don't repeat the same notification within
          <select value={n.cooldownMinutes} onChange={(e) => notify({ cooldownMinutes: Number(e.target.value) })}>
            {[5, 15, 30, 60, 120, 240].map((m) => <option key={m} value={m}>{m} minutes</option>)}
          </select>
        </label>
      </section>

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
