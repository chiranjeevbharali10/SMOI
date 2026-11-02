package com.smoi.auth;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;

import javax.crypto.spec.SecretKeySpec;

import com.nimbusds.jose.jwk.source.ImmutableSecret;
import com.smoi.support.IntegrationTest;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;

import static org.assertj.core.api.Assertions.assertThat;

class AuthIT extends IntegrationTest {

    private static final String PASSWORD = "correct-horse-battery";
    private static final ParameterizedTypeReference<Map<String, Object>> JSON = new ParameterizedTypeReference<>() { };

    @Autowired
    private JwtEncoder appEncoder;

    // ---- helpers -----------------------------------------------------------------------

    private static String uniqueEmail() {
        return "user-" + UUID.randomUUID() + "@example.com";
    }

    private ResponseEntity<Map<String, Object>> register(String email, String password) {
        return http().post().uri("/api/auth/register").contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("email", email, "password", password))
                .retrieve().toEntity(JSON);
    }

    private ResponseEntity<Map<String, Object>> login(String email, String password) {
        return http().post().uri("/api/auth/login").contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("email", email, "password", password))
                .retrieve().toEntity(JSON);
    }

    private ResponseEntity<Map<String, Object>> me(String bearerToken) {
        var req = http().get().uri("/api/me");
        if (bearerToken != null) {
            req = req.header("Authorization", "Bearer " + bearerToken);
        }
        return req.retrieve().toEntity(JSON);
    }

    private String registerAndLogin(String email) {
        assertThat(register(email, PASSWORD).getStatusCode().value()).isEqualTo(201);
        ResponseEntity<Map<String, Object>> res = login(email, PASSWORD);
        assertThat(res.getStatusCode().value()).isEqualTo(200);
        return (String) res.getBody().get("accessToken");
    }

    private String signedToken(JwtEncoder encoder, String subject, String issuer, Instant issuedAt, Instant expiresAt) {
        JwtClaimsSet claims = JwtClaimsSet.builder()
                .issuer(issuer).subject(subject).issuedAt(issuedAt).expiresAt(expiresAt).build();
        return encoder.encode(JwtEncoderParameters.from(JwsHeader.with(MacAlgorithm.HS256).build(), claims))
                .getTokenValue();
    }

    private static String b64url(String s) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(s.getBytes(StandardCharsets.UTF_8));
    }

    // ---- register ----------------------------------------------------------------------

    @Nested
    class Register {

        @Test
        void createsAccountAndNeverReturnsPasswordHash() {
            String email = uniqueEmail();
            ResponseEntity<Map<String, Object>> res = register(email, PASSWORD);

            assertThat(res.getStatusCode().value()).isEqualTo(201);
            assertThat(res.getBody()).containsEntry("email", email).containsKey("id");
            assertThat(res.getBody()).doesNotContainKeys("password", "passwordHash");
        }

        @Test
        void rejectsDuplicateEmailCaseInsensitively() {
            String email = uniqueEmail();
            assertThat(register(email, PASSWORD).getStatusCode().value()).isEqualTo(201);

            assertThat(register(email.toUpperCase(), PASSWORD).getStatusCode().value()).isEqualTo(409);
        }

        @Test
        void rejectsInvalidEmail() {
            assertThat(register("not-an-email", PASSWORD).getStatusCode().value()).isEqualTo(400);
        }

        @Test
        void rejectsShortPassword() {
            assertThat(register(uniqueEmail(), "short").getStatusCode().value()).isEqualTo(400);
        }
    }

    // ---- login -------------------------------------------------------------------------

    @Nested
    class Login {

        @Test
        void returnsBearerTokenThatUnlocksProtectedEndpoint() {
            String email = uniqueEmail();
            register(email, PASSWORD);

            ResponseEntity<Map<String, Object>> res = login(email, PASSWORD);

            assertThat(res.getStatusCode().value()).isEqualTo(200);
            assertThat(res.getBody()).containsEntry("tokenType", "Bearer").containsKeys("accessToken", "expiresAt");

            ResponseEntity<Map<String, Object>> meRes = me((String) res.getBody().get("accessToken"));
            assertThat(meRes.getStatusCode().value()).isEqualTo(200);
            assertThat(meRes.getBody()).containsEntry("email", email);
        }

        @Test
        void wrongPasswordAndUnknownEmailGetTheSameResponse() {
            String email = uniqueEmail();
            register(email, PASSWORD);

            ResponseEntity<Map<String, Object>> wrongPassword = login(email, "wrong-password-123");
            ResponseEntity<Map<String, Object>> unknownEmail = login(uniqueEmail(), PASSWORD);

            assertThat(wrongPassword.getStatusCode().value()).isEqualTo(401);
            assertThat(unknownEmail.getStatusCode().value()).isEqualTo(401);
            assertThat(wrongPassword.getBody().get("detail")).isEqualTo(unknownEmail.getBody().get("detail"));
        }
    }

    // ---- token validation ----------------------------------------------------------------

    @Nested
    class InvalidTokens {

        @Test
        void missingTokenIsRejected() {
            assertThat(me(null).getStatusCode().value()).isEqualTo(401);
        }

        @Test
        void malformedTokenIsRejected() {
            assertThat(me("not-a-jwt").getStatusCode().value()).isEqualTo(401);
        }

        @Test
        void tamperedTokenIsRejected() {
            String token = registerAndLogin(uniqueEmail());
            String[] parts = token.split("\\.");
            // Same header and signature, but the payload now claims a different user.
            String forgedPayload = b64url("{\"iss\":\"smoi\",\"sub\":\"" + UUID.randomUUID()
                    + "\",\"exp\":" + Instant.now().plus(1, ChronoUnit.HOURS).getEpochSecond() + "}");

            assertThat(me(parts[0] + "." + forgedPayload + "." + parts[2]).getStatusCode().value()).isEqualTo(401);
        }

        @Test
        void tokenSignedWithAnotherKeyIsRejected() {
            byte[] otherKey = new byte[32];
            new SecureRandom().nextBytes(otherKey);
            JwtEncoder attacker = new NimbusJwtEncoder(new ImmutableSecret<>(new SecretKeySpec(otherKey, "HmacSHA256")));
            Instant now = Instant.now();
            String token = signedToken(attacker, UUID.randomUUID().toString(), "smoi", now, now.plusSeconds(3600));

            assertThat(me(token).getStatusCode().value()).isEqualTo(401);
        }

        @Test
        void unsignedAlgNoneTokenIsRejected() {
            String header = b64url("{\"alg\":\"none\",\"typ\":\"JWT\"}");
            String payload = b64url("{\"iss\":\"smoi\",\"sub\":\"" + UUID.randomUUID()
                    + "\",\"exp\":" + Instant.now().plus(1, ChronoUnit.HOURS).getEpochSecond() + "}");

            assertThat(me(header + "." + payload + ".").getStatusCode().value()).isEqualTo(401);
        }

        @Test
        void expiredTokenIsRejected() {
            Instant now = Instant.now();
            // Expired two hours ago: well past the decoder's 60-second clock-skew allowance.
            String token = signedToken(appEncoder, UUID.randomUUID().toString(), "smoi",
                    now.minus(3, ChronoUnit.HOURS), now.minus(2, ChronoUnit.HOURS));

            assertThat(me(token).getStatusCode().value()).isEqualTo(401);
        }

        @Test
        void tokenFromWrongIssuerIsRejected() {
            Instant now = Instant.now();
            String token = signedToken(appEncoder, UUID.randomUUID().toString(), "someone-else",
                    now, now.plusSeconds(3600));

            assertThat(me(token).getStatusCode().value()).isEqualTo(401);
        }
    }
}
