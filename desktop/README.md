# SMOI desktop

The pixel-art frog on your Windows desktop (Electron, React, TypeScript). Decisions are in
`docs/adr/0012-desktop-shell-electron.md`.

```sh
npm install
npm start              # build and run
npm run dev            # Vite dev server with hot reload, plus Electron
npm test               # sprite, GIF, state machine, scaling and placement tests
npm run dist           # Windows installer in release/
npm run extract-assets # re-extract the art from docs/design/smoi-character-design.html
```

- **Art** comes unchanged from the design file, extracted by `scripts/extract-design-assets.ts`:
  - `assets/sprites/<state>.png`: 12 strips, 82 frames;
  - `assets/expressions/`: 12 faces;
  - `assets/turnaround/`: three views;
  - `assets/icons/`: the tray icon, rendered from the design's 22x22 SVG;
  - `assets/fonts/`: complete Pixelify Sans and Nunito, with their OFL licences.
  The design's GIFs are kept only as test fixtures (`test/fixtures/gifs/`).
- **States** are chosen by `src/shared/stateMachine.ts`, in the main process:
  - the highest-priority active input wins;
  - "surprised" plays once, then SMOI returns to whatever is still active;
  - sleeping comes from the OS idle timer, and error from the backend health check (`/livez`);
  - walking is an occasional hop along the taskbar.
  SMOI never looks at other windows or apps.
- **Pixels stay even at any Windows scaling.** The frog always covers a whole multiple of 64 device
  pixels (`src/shared/scaling.ts`): 128 at 100%, 192 at 125% and 150%.
- **Clicks pass through transparent pixels** of the current frame. Drag the frog to move it; its
  position is remembered per display.
- **Tray menu:** show or hide, reduced motion (also follows the Windows setting), walking,
  start on login, move back to the corner, and quit. Development builds also have an animation
  preview that plays all 12 states.
