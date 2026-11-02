package com.smoi.ratelimit;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import com.smoi.support.DocumentApiTest;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.TestPropertySource;

import static org.assertj.core.api.Assertions.assertThat;

/** Per-user rate limits: a burst of 3 searches, refilling at 6 per minute. */
@TestPropertySource(properties = {
        "smoi.rate-limit.search.capacity=3",
        "smoi.rate-limit.search.refill-per-minute=6"
})
class RateLimitIT extends DocumentApiTest {

    private ResponseEntity<Map<String, Object>> search(TestUser user) {
        return http().post().uri("/api/search")
                .header("Authorization", "Bearer " + user.token())
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("query", "anything", "mode", "keyword"))
                .retrieve().toEntity(JSON);
    }

    @Test
    void requestsBeyondTheBurstAreRejectedWithRetryAfter() {
        TestUser user = newUser();
        for (int i = 0; i < 3; i++) {
            assertThat(search(user).getStatusCode().value()).isEqualTo(200);
        }

        ResponseEntity<Map<String, Object>> rejected = search(user);

        assertThat(rejected.getStatusCode().value()).isEqualTo(429);
        // 6 per minute = one token every 10 s.
        assertThat(Long.parseLong(rejected.getHeaders().getFirst("Retry-After"))).isBetween(1L, 10L);
        assertThat((String) rejected.getBody().get("detail")).contains("search");
    }

    @Test
    void eachUserHasTheirOwnBucket() {
        TestUser busy = newUser();
        TestUser other = newUser();
        for (int i = 0; i < 4; i++) {
            search(busy);
        }

        assertThat(search(busy).getStatusCode().value()).isEqualTo(429);
        assertThat(search(other).getStatusCode().value()).isEqualTo(200);
    }

    @Test
    void concurrentRequestsCannotSpendTheSameToken() throws Exception {
        TestUser user = newUser();
        List<Callable<Integer>> calls = new ArrayList<>();
        for (int i = 0; i < 12; i++) {
            calls.add(() -> search(user).getStatusCode().value());
        }
        int ok = 0;
        try (ExecutorService pool = Executors.newFixedThreadPool(12)) {
            for (Future<Integer> f : pool.invokeAll(calls)) {
                ok += f.get() == 200 ? 1 : 0;
            }
        }
        // Exactly the burst gets through: the row lock serialises the token checks. (Refill during
        // the test adds at most one more token.)
        assertThat(ok).isBetween(3, 4);
    }

    @Test
    void unlimitedEndpointsAreNotAffected() {
        TestUser user = newUser();
        for (int i = 0; i < 4; i++) {
            search(user);
        }

        assertThat(listDocuments(user).getStatusCode().value()).isEqualTo(200);
    }

    @Test
    void bucketsAreChosenByEndpoint() {
        assertThat(RateLimitFilter.bucketFor(request("POST", "/api/query"))).isEqualTo("query");
        assertThat(RateLimitFilter.bucketFor(request("POST", "/api/query/stream"))).isEqualTo("query");
        assertThat(RateLimitFilter.bucketFor(request("POST", "/api/documents/abc/summary"))).isEqualTo("query");
        assertThat(RateLimitFilter.bucketFor(request("POST", "/api/documents"))).isEqualTo("upload");
        assertThat(RateLimitFilter.bucketFor(request("GET", "/api/documents"))).isNull();
    }

    private static org.springframework.mock.web.MockHttpServletRequest request(String method, String uri) {
        return new org.springframework.mock.web.MockHttpServletRequest(method, uri);
    }
}
