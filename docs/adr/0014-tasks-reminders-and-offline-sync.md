# 0014: Tasks and reminders: Postgres as the source of truth, a local copy on the desktop

- Status: Accepted
- Date: 2026-11-03

## Context

Phase 7 adds tasks and reminders (FR-02). Two requirements pull in different directions:

- the backend is a resume project for backend roles, so tasks should be a real API with a schema,
  tests against Postgres, and per-user isolation like the rest of SMOI;
- tasks must stay usable with the network down (NFR-02.01), reminders must fire with the backend
  unreachable (NFR-02.05), and losing the network must never lose data (NFR-08.05).

The owner chose "backend plus a local copy" over "desktop only".

## Decision

### Storage

- Postgres holds `tasks` and `reminders` (migration `V10`), with `user_id` and soft delete like
  every user-owned table. Every query filters by `user_id`; the two sync reads (`changes`)
  deliberately include rows deleted in the last 30 days, so a device learns about deletions.
- The desktop keeps a JSON copy per account in its data folder (`tasks/<sha256 of email>.json`),
  written to a temporary file and renamed, so a crash can't leave half a file. Every change is
  written there before anything is sent.

### Sync rule

- **The client creates ids** (UUIDs). A task made offline keeps its id when it reaches the
  server, and `PUT /api/tasks/{id}` both creates and updates, so retrying is harmless.
- **The newest edit wins.** Every change carries `editedAt`, the moment the user made it. The
  upsert applies a change only if `editedAt` is at least as new as the stored one; otherwise it
  answers with the newer stored row, and the desktop replaces its copy.
- **A delete always wins.** A deleted row is never changed or brought back (410 Gone).
- **Clock skew is capped**: the server stores `LEAST(editedAt, now())`, so a device with a clock
  in the future can't lock a task against later edits.
- **`last_fired_at` only moves forward** (`GREATEST`), so one device can't make a reminder that
  another already showed fire again.
- The desktop sends its outbox in order (a task before a reminder that points at it), one entry
  per item. While an item has a change waiting, the local version is kept when the server's copy
  is merged in.

All of it is written in this repo: `TaskRepository`/`ReminderRepository` (SQL),
`desktop/src/shared/taskStore.ts` (outbox and merge), `desktop/src/main/tasks.ts` (sending).

### Reminders fire on the desktop

The desktop checks its local copy every 15 seconds (FR-02.04 asks for 60), using
`desktop/src/shared/recurrence.ts`: once, daily, weekly, monthly (the same day, or the month's
last day), or chosen weekdays, at the same local time in the reminder's IANA time zone. Only the
latest due occurrence fires, so a daily reminder doesn't fire seven times after a week offline;
one that came due while SMOI wasn't running fires once, marked as missed.

## Alternatives rejected

| Option | Why not |
| --- | --- |
| Desktop only (a local file, no API) | Simple and offline by design, but no backend work to show, and no path to a second device. |
| Server only, desktop online | Breaks NFR-02.01 and NFR-02.05: no tasks and no reminders with the backend down. |
| Server-side scheduler pushing reminders | Needs a push channel to the desktop and fails exactly when the backend is down. |
| Version numbers with conflicts returned to the user | Correct, but asks a single user to resolve conflicts with themselves. Newest-edit-wins is enough for one person on one or two devices, and easy to explain. |
| CRDTs or a sync library | Far more than a personal task list needs, and hard to explain line by line. |
| SQLite on the desktop | Needs a native module in Electron; a JSON file is plenty for hundreds of tasks. |

## Consequences

- Edits on two devices to the same task while both are offline: the later edit wins whole; the
  other is lost without a prompt. Acceptable for one user; documented here.
- Deletions older than 30 days aren't sent to devices. A device offline for longer keeps a
  deleted item until it next merges, then drops it because the server no longer lists it.
- The local file isn't encrypted (like `settings.json`); it's in the user's own profile folder.
  The sign-in token stays encrypted with safeStorage (ADR 0013).
- Task and reminder text is the user's own input, not retrieved content, but it is still shown as
  plain text only.
