package com.smoi.user;

import java.util.Optional;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * Plain SQL over JdbcClient. Every query excludes soft-deleted rows. The users table
 * owns all other data, so it is looked up by its own id rather than by a user_id.
 */
@Repository
public class UserRepository {

    private final JdbcClient jdbc;

    public UserRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** Inserts a user. Throws DuplicateKeyException if an active account already uses the email. */
    public User insert(String email, String passwordHash) {
        return jdbc.sql("""
                        INSERT INTO users (email, password_hash)
                        VALUES (:email, :passwordHash)
                        RETURNING id, email, password_hash, created_at
                        """)
                .param("email", email)
                .param("passwordHash", passwordHash)
                .query(User.class)
                .single();
    }

    public Optional<User> findActiveByEmail(String email) {
        return jdbc.sql("""
                        SELECT id, email, password_hash, created_at
                        FROM users
                        WHERE lower(email) = lower(:email) AND deleted_at IS NULL
                        """)
                .param("email", email)
                .query(User.class)
                .optional();
    }

    public Optional<User> findActiveById(UUID id) {
        return jdbc.sql("""
                        SELECT id, email, password_hash, created_at
                        FROM users
                        WHERE id = :id AND deleted_at IS NULL
                        """)
                .param("id", id)
                .query(User.class)
                .optional();
    }
}
