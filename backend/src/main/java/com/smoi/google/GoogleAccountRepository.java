package com.smoi.google;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * SQL for {@code google_accounts} and {@code google_oauth_states}. Every query is scoped to a
 * user id and to rows that aren't deleted.
 */
@Repository
public class GoogleAccountRepository {

    public record Account(UUID id, UUID userId, String googleEmail, byte[] refreshTokenEncrypted, int keyVersion,
                          String scopes, String status, String gmailHistoryId, Instant gmailSyncedAt,
                          Instant createdAt) {

        public boolean connected() {
            return "connected".equals(status);
        }
    }

    private static final String COLUMNS = """
            id, user_id, google_email, refresh_token_encrypted, key_version, scopes, status, gmail_history_id,
            gmail_synced_at, created_at""";

    private final JdbcClient jdbc;

    public GoogleAccountRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public Optional<Account> find(UUID userId) {
        return jdbc.sql("SELECT " + COLUMNS + " FROM google_accounts WHERE user_id = :userId AND deleted_at IS NULL")
                .param("userId", userId)
                .query(Account.class)
                .optional();
    }

    /**
     * Saves a new connection, or replaces the token of the existing one (reconnecting). A reconnect
     * keeps the Gmail sync position, so mail already announced isn't announced again.
     */
    public Account save(UUID userId, String googleEmail, byte[] token, String scopes) {
        int updated = jdbc.sql("""
                        UPDATE google_accounts
                           SET google_email = :email, refresh_token_encrypted = :token, key_version = :kv,
                               scopes = :scopes, status = 'connected'
                         WHERE user_id = :userId AND deleted_at IS NULL
                        """)
                .param("email", googleEmail).param("token", token).param("kv", TokenCipher.KEY_VERSION)
                .param("scopes", scopes).param("userId", userId)
                .update();
        if (updated == 0) {
            jdbc.sql("""
                            INSERT INTO google_accounts (user_id, google_email, refresh_token_encrypted, key_version, scopes)
                            VALUES (:userId, :email, :token, :kv, :scopes)
                            """)
                    .param("userId", userId).param("email", googleEmail).param("token", token)
                    .param("kv", TokenCipher.KEY_VERSION).param("scopes", scopes)
                    .update();
        }
        return find(userId).orElseThrow();
    }

    public void setEmail(UUID userId, String email) {
        jdbc.sql("UPDATE google_accounts SET google_email = :email WHERE user_id = :userId AND deleted_at IS NULL")
                .param("email", email).param("userId", userId).update();
    }

    /** Google rejected the refresh token (FR-05.12). Nothing else changes; local data is kept. */
    public void markReconnectRequired(UUID userId) {
        jdbc.sql("UPDATE google_accounts SET status = 'reconnect_required' WHERE user_id = :userId AND deleted_at IS NULL")
                .param("userId", userId).update();
    }

    public void saveHistoryId(UUID userId, String historyId) {
        jdbc.sql("""
                        UPDATE google_accounts SET gmail_history_id = :h, gmail_synced_at = now()
                         WHERE user_id = :userId AND deleted_at IS NULL
                        """)
                .param("h", historyId).param("userId", userId).update();
    }

    /** Disconnect: the encrypted token is overwritten as well as the row soft-deleted. */
    public void delete(UUID userId) {
        jdbc.sql("""
                        UPDATE google_accounts SET deleted_at = now(), refresh_token_encrypted = ''::bytea
                         WHERE user_id = :userId AND deleted_at IS NULL
                        """)
                .param("userId", userId).update();
    }

    // ---- OAuth states ---------------------------------------------------------------------------

    public void saveState(UUID userId, String stateSha256, String codeVerifier, Instant expiresAt) {
        jdbc.sql("""
                        INSERT INTO google_oauth_states (user_id, state_sha256, code_verifier, expires_at)
                        VALUES (:userId, :hash, :verifier, :expires)
                        """)
                .param("userId", userId).param("hash", stateSha256).param("verifier", codeVerifier)
                .param("expires", java.sql.Timestamp.from(expiresAt))
                .update();
    }

    /**
     * Uses up a state: returns its PKCE verifier once, if it exists for this user, hasn't been used
     * and hasn't expired. The single UPDATE makes a replayed or concurrent callback find nothing.
     */
    public Optional<String> consumeState(UUID userId, String stateSha256) {
        return jdbc.sql("""
                        UPDATE google_oauth_states SET deleted_at = now()
                         WHERE user_id = :userId AND state_sha256 = :hash AND deleted_at IS NULL AND expires_at > now()
                        RETURNING code_verifier
                        """)
                .param("userId", userId).param("hash", stateSha256)
                .query(String.class)
                .optional();
    }
}
