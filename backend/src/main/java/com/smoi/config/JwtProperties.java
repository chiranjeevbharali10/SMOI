package com.smoi.config;

import java.time.Duration;
import java.util.Base64;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * JWT settings from {@code smoi.jwt.*}. Validated at startup so a missing or weak
 * secret stops the app instead of silently issuing forgeable tokens.
 */
@ConfigurationProperties(prefix = "smoi.jwt")
public record JwtProperties(String secret, String issuer, Duration ttl) {

    /** HS256 needs a key at least as long as its 256-bit output. */
    static final int MIN_KEY_BYTES = 32;

    public JwtProperties {
        if (secret == null || secret.isBlank()) {
            throw new IllegalStateException("smoi.jwt.secret (JWT_SECRET) must be set");
        }
        if (issuer == null || issuer.isBlank()) {
            throw new IllegalStateException("smoi.jwt.issuer must be set");
        }
        if (ttl == null || ttl.isNegative() || ttl.isZero()) {
            throw new IllegalStateException("smoi.jwt.ttl must be a positive duration");
        }
        byte[] key;
        try {
            key = Base64.getDecoder().decode(secret);
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException("smoi.jwt.secret must be Base64-encoded", e);
        }
        if (key.length < MIN_KEY_BYTES) {
            throw new IllegalStateException(
                    "smoi.jwt.secret must decode to at least " + MIN_KEY_BYTES + " bytes");
        }
    }

    public byte[] keyBytes() {
        return Base64.getDecoder().decode(secret);
    }
}
