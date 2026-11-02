package com.smoi.auth;

import java.util.UUID;

import org.springframework.security.oauth2.jwt.Jwt;

/**
 * The signed-in user's id, taken only from the verified token's subject. Controllers pass it
 * to every query on user-owned data; it never comes from the request body or path.
 */
public final class CurrentUser {

    private CurrentUser() {
    }

    public static UUID id(Jwt jwt) {
        return UUID.fromString(jwt.getSubject());
    }
}
