-- Tasks and reminders (FR-02). The desktop app keeps a local copy and works offline
-- (NFR-02.01), so ids are created by the client: a task made offline keeps its id when it
-- reaches the server, and sending the same change twice is harmless.
--
-- Sync rule (ADR 0014): every change carries `edited_at`, the time the user made it on the
-- desktop. A change is applied only if it is at least as new as the stored one, so the newest
-- edit wins. A delete always wins: a deleted row is never changed or brought back.

CREATE TABLE tasks (
    id           UUID        PRIMARY KEY,
    user_id      UUID        NOT NULL REFERENCES users (id),
    title        TEXT        NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
    description  TEXT        NOT NULL DEFAULT '' CHECK (length(description) <= 5000),
    priority     TEXT        NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
    category     TEXT        NOT NULL DEFAULT '' CHECK (length(category) <= 50),
    due_at       TIMESTAMPTZ,
    -- When the task was completed (FR-02.06). NULL while it is open.
    completed_at TIMESTAMPTZ,
    edited_at    TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at   TIMESTAMPTZ
);

CREATE INDEX tasks_user_idx ON tasks (user_id, due_at) WHERE deleted_at IS NULL;

CREATE TRIGGER tasks_set_updated_at
    BEFORE UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE reminders (
    id            UUID        PRIMARY KEY,
    user_id       UUID        NOT NULL REFERENCES users (id),
    -- Optional: the task this reminder is about. Must belong to the same user (checked in code).
    task_id       UUID        REFERENCES tasks (id),
    title         TEXT        NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
    -- The first occurrence. Recurring reminders repeat at the same local time of day.
    first_at      TIMESTAMPTZ NOT NULL,
    repeat        TEXT        NOT NULL DEFAULT 'none'
                              CHECK (repeat IN ('none', 'daily', 'weekly', 'monthly', 'weekdays')),
    -- For repeat = 'weekdays': which days, as bits. Monday = 1, Tuesday = 2, Wednesday = 4 ...
    -- Sunday = 64 (bit n-1 for ISO day n).
    weekdays      INT         NOT NULL DEFAULT 0 CHECK (weekdays BETWEEN 0 AND 127),
    -- IANA time zone, so "every day at 9:00" stays at 9:00 across daylight-saving changes.
    time_zone     TEXT        NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 64),
    -- The latest occurrence the desktop has shown, so it isn't shown again after a restart.
    last_fired_at TIMESTAMPTZ,
    edited_at     TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at    TIMESTAMPTZ,
    CHECK (repeat <> 'weekdays' OR weekdays > 0)
);

CREATE INDEX reminders_user_idx ON reminders (user_id) WHERE deleted_at IS NULL;

CREATE TRIGGER reminders_set_updated_at
    BEFORE UPDATE ON reminders
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
