# 0020: A static launch page instead of a hosted demo

- Status: Accepted
- Date: 2026-11-08

## Context

Companies reviewing SMOI ask for a live demo. Running SMOI means Docker, a 274 MB embedding model,
a local LLM and the Electron app, so almost nobody who is only curious will do it. The owner's
budget for hosting is $0, and the page is meant for ordinary people first: it should show what
SMOI is like to live with, not how it is built. Engineers get the README one click away.

## Decisions

1. **A static site in `site/`, hosted free on Vercel.** There is no server, so it has no running
   cost, can't be abused, and never goes to sleep. `site/vercel.json` builds it. The Vercel
   project's root directory is `site/`.
2. **Built from the app, not a copy of it.** `site/vite.config.ts`:
   - aliases `@desktop` to `desktop/src`;
   - serves `desktop/assets` as its public folder;
   - generates `virtual:smoi-roster` from the companion manifests with the desktop's own
     `loadRoster`.

   The page uses the app's tokens, `BubbleView`, `PanelView`, sprite drawing, panel lines
   (`effectOf`) and personality wording (`react`). If the app changes, the page changes with it,
   and the art, palette and fonts are never redrawn. React is pinned to the site's copy so desktop
   files don't load a second React.
3. **The one AI answer is recorded, not live, and the page says so.** `site/scripts/record-demo.ts`
   runs against a local stack:
   - it registers a throwaway account and uploads the evaluation corpus's frog documents
     (CC BY-SA);
   - it asks one question through `/api/query/stream` and saves every event as streamed, plus the
     cited passages, to `site/src/data/brain-demo.json`;
   - it deletes the uploaded documents afterwards.

   The page replays those events through the desktop's own `reduceAnswer` and labels it "A real
   answer from SMOI, recorded <date>". Until a recording exists, the scene says so rather than
   showing a made-up answer.
4. **Nothing on the page pretends.**
   - There is no download button while there is no installer (Phase 9), only "Coming soon for
     Windows".
   - There are no user counts or reviews.
   - Sample tasks and emails are labelled as samples.
5. **Accessible and calm.** The page follows the visitor's reduced-motion setting: still frames,
   and the full answer at once. Every canvas has a label or is hidden from screen readers, and the
   panel keeps the app's keyboard controls.

## Alternatives rejected

- **A hosted backend demo on a free VM (Oracle Always Free) with a local LLM.**
  - Free ARM capacity is unreliable, and CPU-only answers are slow.
  - Public guest accounts need the Phase 5 security work first.
  - It also shows a search box rather than the experience.
  - It can come later behind the same page.
- **A hosted demo with a Claude API key.** It costs money per visitor, and a public endpoint that
  spends money invites abuse.
- **Copying the art and components into `site/`.** The copies would drift from the app and break
  the rule that the design file is the source of truth.
- **A browser extension.** Visitors would have to install something from a stranger to see a demo.

## Consequences

- The page shows only behaviour SMOI really has. Interactive parts run the app's real code paths
  with sample data.
- Changing a desktop component changes the page. `cd site && npm test` and `npm run build` should
  be run after desktop UI changes.
- The recorded answer gets old as the model or prompts change. Re-run `npm run record-demo` to
  refresh it.
- Vercel must be allowed to read files outside `site/` (its "include files outside the root
  directory" setting, on by default).
