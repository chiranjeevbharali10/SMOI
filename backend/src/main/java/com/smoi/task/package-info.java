/**
 * Tasks and reminders (FR-02). The desktop app keeps a local copy, works offline and fires
 * reminders itself; this package is the copy every device syncs with. Every query is scoped to
 * the authenticated user. The sync rule (newest edit wins, deletes always win) is explained in
 * {@code docs/adr/0014-tasks-reminders-and-offline-sync.md}.
 */
package com.smoi.task;
