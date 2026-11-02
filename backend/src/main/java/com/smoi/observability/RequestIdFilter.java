package com.smoi.observability;

import java.io.IOException;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Gives every request an id: the caller's {@code X-Request-Id} if it is safe, otherwise a new
 * UUID. The id is returned in the response header and put in the logging MDC. Runs first, before
 * security, so even a rejected request's log lines and response carry it.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RequestIdFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String id = RequestIds.fromHeader(request.getHeader(RequestIds.HEADER));
        response.setHeader(RequestIds.HEADER, id);
        try (var ignored = RequestIds.bind(id)) {
            chain.doFilter(request, response);
        }
    }
}
