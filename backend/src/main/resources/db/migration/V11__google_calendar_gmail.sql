-- Phase 8: Google Calendar and Gmail (FR-04, FR-05, FR-02.05, FR-06.02). See ADR 0017 and 0018.

-- One Google connection per user. The refresh token is encrypted with AES-256-GCM using a key
-- from the environment (GOOGLE_TOKEN_KEY), with the user id as associated data, so a ciphertext
-- copied into another user's row doesn't decrypt (NFR-03.03). Access tokens are never stored.
CREATE TABLE google_accounts (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID        NOT NULL REFERENCES users (id),
    google_email            TEXT        NOT NULL,
    -- 12-byte IV followed by the ciphertext and 16-byte tag.
    refresh_token_encrypted BYTEA       NOT NULL,
    -- Which key encrypted it, so the key can be rotated later.
    key_version             INT         NOT NULL DEFAULT 1,
    -- Space-separated scopes Google actually granted (the user can untick some).
    scopes                  TEXT        NOT NULL,
    -- connected, or reconnect_required after Google rejected the refresh token (FR-05.12).
    status                  TEXT        NOT NULL DEFAULT 'connected'
                                        CHECK (status IN ('connected', 'reconnect_required')),
    -- Gmail sync position (users.history.list). NULL until the first bounded sync.
    gmail_history_id        TEXT,
    gmail_synced_at         TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at              TIMESTAMPTZ
);

CREATE UNIQUE INDEX google_accounts_user_active_uk ON google_accounts (user_id) WHERE deleted_at IS NULL;

CREATE TRIGGER google_accounts_set_updated_at
    BEFORE UPDATE ON google_accounts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A pending OAuth sign-in (authorization code flow with PKCE, FR-04.01). The browser comes back
-- with `state`, which holds the user id and a random secret; only the secret's hash is stored.
-- Single use, and valid for 10 minutes.
CREATE TABLE google_oauth_states (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL REFERENCES users (id),
    state_sha256  TEXT        NOT NULL,
    code_verifier TEXT        NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Set when used, so a replayed callback finds nothing.
    deleted_at    TIMESTAMPTZ
);

CREATE INDEX google_oauth_states_lookup_idx ON google_oauth_states (user_id, state_sha256) WHERE deleted_at IS NULL;

CREATE TRIGGER google_oauth_states_set_updated_at
    BEFORE UPDATE ON google_oauth_states
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- An email SMOI has seen (FR-05.02). Email content is untrusted data: it is shown as plain text,
-- and the classifier that reads it has no tools and can only return a category and a summary.
CREATE TABLE emails (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID        NOT NULL REFERENCES users (id),
    gmail_id         TEXT        NOT NULL CHECK (length(gmail_id) BETWEEN 1 AND 64),
    thread_id        TEXT        NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 64),
    from_address     TEXT        NOT NULL DEFAULT '' CHECK (length(from_address) <= 500),
    subject          TEXT        NOT NULL DEFAULT '' CHECK (length(subject) <= 1000),
    received_at      TIMESTAMPTZ NOT NULL,
    -- Plain text body, capped, kept so the user can index it into SMOI Brain on request.
    body_text        TEXT        NOT NULL DEFAULT '' CHECK (length(body_text) <= 20000),
    -- NULL while not classified (for example a hosted LLM without the user's permission).
    category         TEXT        CHECK (category IN ('recruitment', 'academic', 'personal', 'important', 'promotional')),
    summary          TEXT        NOT NULL DEFAULT '' CHECK (length(summary) <= 1000),
    -- When the desktop was told about it. Set once, in the same statement that hands the alert
    -- out, so a restart or another poll can never announce it again.
    announced_at     TIMESTAMPTZ,
    -- SMOI Brain document holding this email, if the user chose to index it (off by default).
    document_id      UUID        REFERENCES documents (id),
    -- Task made from this email (FR-02.05).
    task_id          UUID        REFERENCES tasks (id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at       TIMESTAMPTZ
);

-- One row per Gmail message per user, so a repeated sync can't add it twice.
CREATE UNIQUE INDEX emails_user_gmail_active_uk ON emails (user_id, gmail_id) WHERE deleted_at IS NULL;
CREATE INDEX emails_user_received_idx ON emails (user_id, received_at DESC) WHERE deleted_at IS NULL;

CREATE TRIGGER emails_set_updated_at
    BEFORE UPDATE ON emails
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Gmail drafts SMOI created (FR-05.08). SMOI only updates drafts listed here (FR-05.09).
CREATE TABLE gmail_drafts (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID        NOT NULL REFERENCES users (id),
    gmail_draft_id   TEXT        NOT NULL CHECK (length(gmail_draft_id) BETWEEN 1 AND 64),
    gmail_message_id TEXT        NOT NULL CHECK (length(gmail_message_id) BETWEEN 1 AND 64),
    to_address       TEXT        NOT NULL CHECK (length(to_address) <= 320),
    subject          TEXT        NOT NULL CHECK (length(subject) <= 998),
    body             TEXT        NOT NULL CHECK (length(body) <= 20000),
    -- Set when Gmail says the draft is gone (sent or deleted by the user in Gmail).
    gone_at          TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at       TIMESTAMPTZ
);

CREATE INDEX gmail_drafts_user_idx ON gmail_drafts (user_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TRIGGER gmail_drafts_set_updated_at
    BEFORE UPDATE ON gmail_drafts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A proposed change to Google (an event to create, change or delete; a draft to create or
-- update). Nothing reaches Google until the user confirms it (FR-04.04, FR-05.08). The row's id
-- is the idempotency key: confirming twice, or retrying after a timeout, applies it once and
-- returns the same result (NFR-02.03).
CREATE TABLE google_actions (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID        NOT NULL REFERENCES users (id),
    kind        TEXT        NOT NULL CHECK (kind IN ('create_event', 'update_event', 'delete_event',
                                                     'create_draft', 'update_draft')),
    -- The exact change the user saw and confirmed, validated when it was proposed.
    payload     JSONB       NOT NULL,
    -- applying: the call to Google was made but its answer wasn't recorded (a crash or timeout).
    -- A retry first looks for what that call may have created, so it isn't created twice.
    status      TEXT        NOT NULL DEFAULT 'proposed'
                            CHECK (status IN ('proposed', 'applying', 'applied', 'failed')),
    -- What Google returned, so a repeated confirm answers the same.
    result      JSONB,
    expires_at  TIMESTAMPTZ NOT NULL,
    applied_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at  TIMESTAMPTZ
);

CREATE INDEX google_actions_user_idx ON google_actions (user_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TRIGGER google_actions_set_updated_at
    BEFORE UPDATE ON google_actions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A reminder can be about a draft: "remind me to send this tomorrow at 9" (FR-05.10). If the
-- draft is gone before the reminder fires, the reminder is cancelled and says why (FR-05.11).
ALTER TABLE reminders ADD COLUMN draft_id UUID REFERENCES gmail_drafts (id);
ALTER TABLE reminders ADD COLUMN cancelled_reason TEXT
    CHECK (cancelled_reason IS NULL OR cancelled_reason IN ('draft_gone'));
