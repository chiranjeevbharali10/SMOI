package com.smoi.config;

import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;

import com.nimbusds.jose.jwk.source.ImmutableSecret;
import com.smoi.ratelimit.RateLimitFilter;
import com.smoi.ratelimit.RateLimiter;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;
import org.springframework.security.oauth2.server.resource.web.authentication.BearerTokenAuthenticationFilter;
import org.springframework.security.web.SecurityFilterChain;

/**
 * Stateless API security. Clients log in once, get a signed JWT, and send it as
 * {@code Authorization: Bearer <token>}. Spring's OAuth2 resource server checks the
 * signature, expiry and issuer on every request. See docs/adr/0003.
 */
@Configuration
public class SecurityConfig {

    @Bean
    SecurityFilterChain apiSecurity(HttpSecurity http, RateLimiter rateLimiter) throws Exception {
        http
                // No cookies or server sessions, so CSRF does not apply.
                .csrf(csrf -> csrf.disable())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers(HttpMethod.POST, "/api/auth/register", "/api/auth/login").permitAll()
                        .requestMatchers(HttpMethod.GET, "/actuator/health", "/actuator/health/**", "/livez", "/readyz").permitAll()
                        // Served only on the management port, which Compose does not publish (docs/adr/0011).
                        .requestMatchers(HttpMethod.GET, "/actuator/prometheus").permitAll()
                        // Google's redirect after consent. The browser has no SMOI token; the single-use,
                        // unguessable state parameter identifies the user (GoogleOAuthService).
                        .requestMatchers(HttpMethod.GET, "/api/google/callback").permitAll()
                        .requestMatchers("/error").permitAll()
                        .anyRequest().authenticated())
                .oauth2ResourceServer(rs -> rs.jwt(Customizer.withDefaults()))
                // Per-user rate limits, once the user is known from the token.
                .addFilterAfter(new RateLimitFilter(rateLimiter), BearerTokenAuthenticationFilter.class);
        return http.build();
    }

    @Bean
    SecretKey jwtSigningKey(JwtProperties props) {
        return new SecretKeySpec(props.keyBytes(), "HmacSHA256");
    }

    @Bean
    JwtEncoder jwtEncoder(SecretKey jwtSigningKey) {
        return new NimbusJwtEncoder(new ImmutableSecret<>(jwtSigningKey));
    }

    @Bean
    JwtDecoder jwtDecoder(SecretKey jwtSigningKey, JwtProperties props) {
        NimbusJwtDecoder decoder = NimbusJwtDecoder.withSecretKey(jwtSigningKey)
                // Only HS256 is accepted. Tokens claiming "alg: none" or any other algorithm are rejected.
                .macAlgorithm(MacAlgorithm.HS256)
                .build();
        // Default validators check exp/nbf (60s clock skew); we add the issuer check.
        decoder.setJwtValidator(JwtValidators.createDefaultWithIssuer(props.issuer()));
        return decoder;
    }

    @Bean
    PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }
}
