package com.smoi.ratelimit;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

import com.smoi.auth.CurrentUser;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Applies {@link RateLimiter} to the expensive endpoints, after authentication so the limit is per
 * user. Over the limit: HTTP 429 with {@code Retry-After}. Cheap reads (lists, status) aren't
 * limited.
 *
 * <p>Not a Spring bean on purpose: {@code SecurityConfig} adds it to the security filter chain at
 * the right position, and a bean would also be registered a second time as a plain servlet filter.
 */
public class RateLimitFilter extends OncePerRequestFilter {

    private final RateLimiter limiter;

    public RateLimitFilter(RateLimiter limiter) {
        this.limiter = limiter;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String bucket = bucketFor(request);
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (bucket != null && auth != null && auth.getPrincipal() instanceof Jwt jwt) {
            RateLimiter.Decision decision = limiter.tryAcquire(CurrentUser.id(jwt), bucket);
            if (!decision.allowed()) {
                response.setStatus(429);
                response.setHeader("Retry-After", Long.toString(decision.retryAfterSeconds()));
                response.setContentType("application/problem+json");
                response.getOutputStream().write(("""
                        {"type":"about:blank","title":"Too Many Requests","status":429,\
                        "detail":"Rate limit for %s requests reached. Try again in %d seconds."}"""
                        .formatted(bucket, decision.retryAfterSeconds())).getBytes(StandardCharsets.UTF_8));
                return;
            }
        }
        chain.doFilter(request, response);
    }

    static String bucketFor(HttpServletRequest request) {
        if (!"POST".equals(request.getMethod())) {
            return null;
        }
        String path = request.getRequestURI();
        if (path.equals("/api/query") || path.equals("/api/query/stream")
                || path.equals("/api/documents/compare") || path.matches("/api/documents/[^/]+/summary")) {
            return RateLimitProperties.QUERY;
        }
        if (path.equals("/api/search")) {
            return RateLimitProperties.SEARCH;
        }
        if (path.equals("/api/documents")) {
            return RateLimitProperties.UPLOAD;
        }
        return null;
    }
}
