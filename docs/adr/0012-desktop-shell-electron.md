# 0012: Desktop shell: Electron with React and TypeScript

- Status: Accepted
- Date: 2026-11-03

## Context

SMOI's frog needs four things from the desktop shell:

- a transparent, frameless, always-on-top window, where clicks pass through the transparent pixels
  of the current frame;
- pixel-exact rendering at fractional Windows scaling (125%, 150%);
- a tray icon and start-on-login;
- a Windows installer.

Phase 6B adds speech bubbles, a menu panel and a dashboard, so the shell also needs a
comfortable UI toolkit. CLAUDE.md fixes Electron, React and TypeScript for the desktop app. This ADR
records why, against the two realistic alternatives.

## Options

| | Electron | Tauri 2 | JavaFX |
| --- | --- | --- | --- |
| Rendering engine | Bundled Chromium: identical everywhere | The OS WebView (WebView2 on Windows, based on Edge/Chromium) | Its own scene graph (Prism) |
| UI language | TypeScript and React | TypeScript and React, plus Rust for the shell | Java or Kotlin |
| Transparent, click-through window | `transparent: true` and `setIgnoreMouseEvents(true, { forward: true })`, a documented API for exactly this pattern | Transparency supported; click-through per pixel needs manual cursor polling (no "forward" mode) | Transparent stages work; per-pixel click-through needs native code (JNA) on Windows |
| Pixel-exact canvas at fractional DPI | `devicePixelRatio` and canvas backing size, the same as in a browser | Same as Electron (WebView2 is Chromium) | Possible, but HiDPI scaling of canvases is less predictable on Windows |
| Tray, login item, installer | Built in, plus electron-builder (NSIS) | Built in (plugins), MSI/NSIS bundler | Tray through AWT (dated look), installer through jpackage |
| Installer size | About 117 MB for SMOI (`SMOI-Setup-0.1.0.exe`, measured) | Typically a few MB, because the WebView isn't bundled | JRE included through jlink, typically tens of MB |
| Memory use | **TBD, not measured** | **TBD, not measured** | **TBD, not measured** |
| Fit with the backend developer's skills | Same language as the web dashboard | Adds Rust | Same language as the backend |

Memory use matters for an app that is always running. It isn't measured here: the owner has
paused performance measurement, and a fair comparison needs the same app built three ways. Common
expectations are that Electron uses the most memory, since every app ships its own Chromium; Tauri
uses less, since it shares the system WebView2; and JavaFX sits in between, depending on the JVM's
heap settings. Those are expectations, not SMOI numbers.

## Decision

**Electron 45, React 19, TypeScript, built with Vite and packaged with electron-builder (NSIS).**

- **Behaviour:** the click-through pattern SMOI needs, transparent except where the frog is drawn,
  is a single documented API in Electron. In Tauri or JavaFX it needs native workarounds.
- **Rendering:** the bundled Chromium renders identically on every Windows version, which matters
  for exact pixel-art scaling.
- **One language:** the Phase 6B panel, bubbles and dashboard are web UI, so the frog and the rest
  of the app share one language and toolkit.

**Security settings:**

- `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`;
- a preload script that exposes only seven functions;
- a strict Content-Security-Policy with no inline scripts and only the app's own files (the
  Vite dev server alone relaxes it, for hot reload);
- navigation and new windows are blocked.

**Main process owns behaviour; the renderer only draws.** The state machine
(`src/shared/stateMachine.ts`) runs in the main process, because that's where its inputs are:

- OS idle time, which drives sleeping;
- backend health, which drives error;
- walks along the taskbar.

The renderer draws frames, decides click-through from the opaque pixels of the frame being shown,
and reports when the one-shot "surprised" animation has finished. SMOI never looks at other windows
or apps.

## Alternatives rejected

- **Tauri:** smaller and lighter, and the best choice if memory or download size became the main
  constraint. Rejected for now: it adds Rust to the project, and per-pixel click-through needs
  hand-written cursor polling.
- **JavaFX:** keeps one language with the backend, but per-pixel click-through, the tray and
  installers on Windows all need native glue or older AWT APIs, and Phase 6B's UI would be harder
  to build than with React.

## Consequences

- The installer is large (about 117 MB) and the app carries its own Chromium.
- Electron releases must be kept current for security fixes.
- Memory use is unmeasured. If it becomes a problem, Tauri is the documented fallback; the renderer
  code (React and canvas) would carry over.
