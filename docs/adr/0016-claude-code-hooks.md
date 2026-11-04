# 0016: Claude Code notifications through a local hook listener

- Status: Accepted
- Date: 2026-11-04

## Context

The owner wants SMOI to say when a Claude Code session finishes a long run or is blocked on a
permission prompt (FR-10). Claude Code can run shell commands on hook events. The hook input
includes the prompt text and paths, which are private, and any local process or web page could
try to reach a local port.

## Decisions

1. **The listener lives in the desktop app's main process, not the backend.** The frog is on the
   desktop, the backend runs in Docker and may be down, and these events have nothing to do with
   a user account or the database.
2. **Bound to 127.0.0.1, with a shared secret in a header.** The secret comes from
   `SMOI_HOOK_SECRET` and is compared in constant time (both sides hashed first, so the lengths
   leak nothing). With no secret set, the listener doesn't start. The hook commands read the
   secret from the environment, so it is never written into `settings.json`.
3. **The Host header must be the loopback address.** This blocks DNS rebinding. Browsers can't
   send the custom header cross-origin without a CORS preflight, which the server never approves.
4. **Payloads are untrusted and minimised.** At most 64 KB of JSON. Only `session_id` (1 to 128 of
   `[A-Za-z0-9_-]`) and `hook_event_name` (which must match the route) are kept. Rejections log a
   reason only, never the body.
5. **Answer before reacting.** The listener replies 204 before the frog does anything, and the hooks
   use `curl -m 2 ... || true`, so a slow or closed SMOI never delays Claude Code or shows it an error.
6. **Run rules are a pure module** (`src/shared/claudeRuns.ts`), like the bubble and state machine
   rules, so duplicates, parallel sessions, a missing start and stale runs are unit-tested without
   clocks.
7. **Alerts go through the existing notifier** as two new categories, so the category toggles,
   priorities, quiet hours and the native-notification option apply with no new code.
8. **A new `attention` pose**, so "blocked" looks different from "surprised" (urgent email) and
   "celebrating". The owner asked for a new pose. It is drawn by `desktop/scripts/draw-attention-pose.ts`
   from existing pixels: the body of surprised's last frame and listening's badge with a "!".
   A test checks it uses only colours already in the design. It stays marked as a draft
   (`DRAFT_STATES`) until the owner approves it and it is added to the design board.

## Alternatives rejected

| Option | Why not |
| --- | --- |
| Backend endpoint | Needs Docker running and a user account for a purely local, per-machine signal. |
| SMOI edits `~/.claude/settings.json` | The owner's rule: SMOI never changes Claude Code's settings. A printed config is reviewable. |
| Named pipe or file watching | Harder to send from a one-line hook, and harder to test than HTTP on a real socket. |
| Secret in the URL | URLs end up in process lists and logs; a header doesn't. |
| Reusing the surprised pose | Urgent email already uses it, so you couldn't tell "blocked" from "new mail" at a glance. |

## Consequences

- Users have to set one environment variable and merge three hooks by hand.
- A done with no start (SMOI was closed when the run began) is silent by design, because the
  duration is unknown.
- `waiting` at normal priority is held during quiet hours. Setting the category to high priority
  shows it anyway.
