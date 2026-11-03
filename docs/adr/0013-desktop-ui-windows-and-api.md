# 0013: Desktop UI: bubble and panel windows, and a main-process API client

- Status: Accepted
- Date: 2026-11-03

## Context

Phase 6B adds SMOI's speech bubbles, the menu panel and the dashboard (login, SMOI Brain,
settings) to the Phase 6A frog (ADR 0012). The owner set these constraints:

- the frog must not move by one pixel, and must stay crisp, when the bubble or panel appears, at
  100%, 125% and 150% scaling and across monitors;
- clicks must still pass through empty space;
- bubbles never take focus; the panel takes keyboard focus while open and gives it back on close;
- the JWT is stored with Electron's safeStorage, and never in plain text;
- answers, passages and chunks are plain text, and nothing in retrieved content can open a link,
  load an image, navigate or open a window.

## Decisions

### 1. The bubble and the panel are separate windows; the frog window never changes

| Option | Problem |
| --- | --- |
| Grow the frog's window to hold the bubble and panel | The bubble and panel sit above and beside the frog, so the window has to grow up and sideways, which moves its origin. Windows moves the window before Chromium repaints it, so the frog can be drawn one frame in the wrong place. At 125% and 150% the frog's offset inside the window must also land on whole device pixels. |
| One fixed, large transparent window | To let the panel flip sides it must extend on both sides of the frog. Near a monitor edge, Windows gives a window the scale of the monitor holding most of it, so the frog could be drawn at the other monitor's scale. |
| **Separate windows (chosen)** | The frog window keeps the same size and position whatever the bubble and panel do. |

- **Bubble window:** transparent and `focusable: false`, so it can never take focus. Clicks pass
  through it (`setIgnoreMouseEvents(true, { forward: true })`), except over a pink bubble's x button.
- **Panel window:** transparent and focusable. It takes focus when it opens.
- **Placement:** both are placed from the frog's bounds by the pure functions in
  `desktop/src/shared/layout.ts`. The panel flips to the right of the frog when there's no room
  on the left. The bubble stays fully on screen, never covers the panel, and moves its tail to
  keep pointing at the frog.
- **Following the frog:** when the frog moves (a drag, a walk, a display change), both windows
  are re-placed.
- **The frog window is `focusable: false`.** Clicking it never activates it, so the app the user
  was in stays active until the panel opens.

### 2. Closing the panel destroys its window

Found by the desktop check (`desktop/scripts/desktop-check.ts`):

- **Hiding** the focused panel left Windows' foreground on the now invisible panel, so the
  user's app didn't get keyboard focus back.
- **Blurring first** (Electron's `blur()`) activated the next visible window in z-order, which
  was the taskbar.
- **Destroying** the panel window makes Windows reactivate the window that was active before it,
  which is the user's app, because the frog and bubble windows can't take focus. A new hidden
  panel is created straight away, so the next open is still instant.

This needs no knowledge of other apps: SMOI still never looks at other windows.

### 3. All HTTP runs in the main process

- The dashboard calls a small typed IPC API (`desktop/src/shared/bridge.ts`). The main process
  holds the session and makes every request (`desktop/src/main/api.ts`).
- **No token in renderers.** The page never sees the JWT, and its Content-Security-Policy still
  forbids any network access (`connect-src 'self'`).
- **No backend changes:** no CORS rules are needed, because requests don't come from a web origin.
- **One place for errors.** Every failure becomes a plain message saying what went wrong and what
  to do, for example "Can't reach the SMOI backend at http://127.0.0.1:8080. Check that it's
  running." The frog's personality never replaces these messages.
- **IPC checks.** Every handler checks which window sent the message and validates its arguments.
- **Uploads.** The main process opens the file picker itself and never accepts a file path from a
  page. Drag-and-drop upload was left out for this reason.
- **Deletes.** A native confirmation dialog runs before any document is deleted.

### 4. The session is saved only with safeStorage

- When `safeStorage.isEncryptionAvailable()` is true, the token is encrypted (Windows DPAPI) and
  written to `session.bin` in the app's data folder.
- When encryption isn't available, the token stays in memory only. The dashboard then says
  "Windows can't encrypt SMOI's saved sign-in on this computer, so it isn't saved. You'll need to
  sign in again next time."
- An expired token, or one the backend rejects (401), is deleted. Tokens last at most an hour
  (NFR-03.02) and there's no refresh endpoint, so the user signs in again after that.
- Electron 45 marks the synchronous safeStorage calls as deprecated in favour of async ones. They
  still work; moving to the async API is a small follow-up.

### 5. Content from documents and models is plain text

- Answers, passages and chunks are rendered as React text nodes, never as HTML or Markdown, so
  markup, image links and URLs show as the characters they are.
  `desktop/test/components.test.tsx` checks this with a chunk containing an `<img>` tag, a Markdown
  image, a link and a script tag.
- Every window denies `window.open`, navigation, redirects and `<webview>`. The Phase 6A rule that
  opened `https://` links in the browser was removed, because nothing in the app needs it yet.

### 6. What "open a cited source" shows

A citation opens a source viewer in the dashboard. It shows the cited chunk, highlighted, with up
to two chunks either side, plus the file name and page or section.

**Limitation:** it shows the text SMOI indexed, not the original file. The backend has no endpoint
that returns an uploaded file (ADR 0007 stores files in Postgres for re-indexing only). Opening the
original PDF or Word file at the cited page would need a new user-scoped download endpoint and an
ADR of its own.

### 7. Frog states from the UI

- **Priority:** error, then thinking or speaking, then working, then idle (tested in
  `desktop/test/stateMachine.test.ts`).
- **Thinking and speaking:** thinking while a question waits for its first words, speaking while
  they stream.
- **Working:** while any document is queued or processing. The document list is polled every
  2 seconds only during that time.
- **LLM fallback** (`llm_unavailable`): a 4-second error reaction plus a banner that lists the
  retrieved passages. Error isn't a lasting state here, because the backend itself is fine.
- **Opening SMOI Brain:** a 2-second thinking reaction. The lavender "I found something
  interesting for you." appears only when an answer with valid citations arrives.

## Alternatives rejected

- **Renderer calls the backend directly:** this needs CORS in the backend, a token in the page,
  and a looser CSP.
- **Electron `blur()` or `hide()` to give focus back:** see section 2.
- **Rendering answers as Markdown:** nicer formatting, but it would turn retrieved text into links
  and images.

## Consequences

- The app has four kinds of window: frog, bubble, panel and dashboard. Their positions are
  coordinated by `desktop/src/main/companion.ts`.
- Recreating the panel window costs one small renderer process per close. That process starts
  while the panel is hidden, so opening isn't slowed.
- **Screen readers:**
  - The bubble window never has focus, and screen readers often ignore live regions in an
    unfocused window. While the panel is open, its own live region repeats the bubble's line.
  - With the panel closed, whether Narrator or NVDA announces a bubble hasn't been verified. It
    is in the manual checklist (`docs/design/phase6b-comparison.md`).
- **Keyboard users** reach the panel from the tray menu ("Open SMOI menu"), because the frog
  can't take focus. A pink bubble's x button can't be reached by keyboard either, so the tray has
  "Dismiss SMOI's message".
