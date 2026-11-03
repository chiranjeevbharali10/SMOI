# SMOI desktop

The pixel-art frog on your Windows desktop, with its speech bubbles, menu panel and dashboard
(Electron, React, TypeScript). Decisions are in `docs/adr/0012-desktop-shell-electron.md` (the
shell) and `docs/adr/0013-desktop-ui-windows-and-api.md` (bubbles, panel, dashboard, API).

```sh
npm install
npm start              # build and run
npm run dev            # Vite dev server with hot reload, plus Electron
npm test               # unit and component tests (vitest)
npm run dist           # Windows installer in release/
npm run extract-assets # re-extract the art from docs/design/smoi-character-design.html

# Real-desktop checks (build first; they move the mouse and type: hands off while they run)
npx tsx scripts/desktop-check.ts            # focus, click-through, crisp/no-shift at 100/125/150%, monitors
npx tsx scripts/measure-dashboard-open.ts   # NFR-01.02 dashboard open time, cold and warm
npx electron scripts/capture-ui.mjs          # screenshots for docs/design/phase6b-comparison.md
```

The desktop check and the measurement run with a throwaway profile, and sign in with a test
account only if you set `SMOI_E2E_EMAIL` and `SMOI_E2E_PASSWORD` in the environment. Never put a
real password in a file in this repo.

## The frog (Phase 6A)

- **Art** comes unchanged from the design file, extracted by `scripts/extract-design-assets.ts`:
  - `assets/sprites/<state>.png`: 12 strips, 82 frames;
  - `assets/expressions/`: 12 faces, used as small status icons in the dashboard;
  - `assets/turnaround/`: three views;
  - `assets/icons/`: the tray icon, rendered from the design's 22x22 SVG;
  - `assets/fonts/`: complete Pixelify Sans and Nunito, with their OFL licences.
- **States** are chosen by `src/shared/stateMachine.ts`, in the main process. The order is error,
  then thinking or speaking, then working, then idle. Brief reactions (happy, surprised, thinking,
  error and others) show for a few seconds on top of that. SMOI never looks at other windows or
  apps.
- **Pixels stay even at any Windows scaling.** The frog always covers a whole multiple of 64
  device pixels (`src/shared/scaling.ts`).
- **Clicks pass through transparent pixels.** Drag the frog to move it; click it to open the panel.
  The frog window never takes focus.

## Bubbles, panel and dashboard (Phase 6B)

- **Design tokens** live in one file, `src/renderer/theme/tokens.css`. `test/contrast.test.ts`
  checks every text and background pair against WCAG AA.
- **Speech bubbles** (`src/shared/bubbles.ts`, `src/main/companion.ts`):
  - blue nudges and lavender findings fade after a few seconds;
  - pink time-sensitive bubbles stay until you press x, or choose "Dismiss SMOI's message" in the
    tray;
  - each bubble is a separate window that never takes focus, stays on screen, and points its tail
    at the frog.
- **Menu panel:**
  - click the frog, or choose "Open SMOI menu" in the tray, to open it;
  - it takes keyboard focus: Up and Down move between rows, Enter chooses, Esc closes and gives
    focus back to the app you were in;
  - what each row does is in `src/shared/panelActions.ts`;
  - tasks, calendar and inbox read "Not available yet" until those features exist.
- **Dashboard:** Login, Home, SMOI Brain (upload, indexing status, chat with cited answers) and
  Settings. The design file doesn't include these screens: they are an interpretation built from
  its tokens.
- **Backend access:** only the main process talks to the backend (`src/main/api.ts`). The JWT is
  saved only encrypted with Electron safeStorage; if encryption isn't available it is kept in
  memory and you sign in again next time.
- **Plain text only:** answers, passages and chunks are always plain text. Links in documents
  aren't clickable and images don't load. No window can navigate or open another window.

### Known limitations

- **Source viewer:** opening a cited source shows the text SMOI indexed (the cited chunk and its
  neighbours), not the original PDF or Word file. The backend has no endpoint that returns the
  uploaded file.
- **Uploads:** only through the "Add documents…" file picker, which the main process opens.
  Drag-and-drop isn't supported, because it would hand a file path from the page to the main
  process.
- **Screen readers:** bubbles are announced through live regions, and repeated in the panel while
  it is open. With the panel closed, whether a screen reader announces a bubble in the unfocused
  bubble window hasn't been verified.
