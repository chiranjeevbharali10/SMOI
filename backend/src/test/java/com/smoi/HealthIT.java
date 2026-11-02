package com.smoi;

import java.util.Map;

import com.smoi.support.IntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.ResponseEntity;

import static org.assertj.core.api.Assertions.assertThat;

class HealthIT extends IntegrationTest {

    @Test
    void healthIsUpWithoutAuthentication() {
        ResponseEntity<Map<String, Object>> res = http().get().uri("/actuator/health")
                .retrieve().toEntity(new ParameterizedTypeReference<>() { });

        assertThat(res.getStatusCode().value()).isEqualTo(200);
        assertThat(res.getBody()).containsEntry("status", "UP");
    }

    @Test
    void otherActuatorEndpointsAreNotExposed() {
        // Not public: either rejected (401) or not exposed at all (404). Never 200.
        int status = http().get().uri("/actuator/env").retrieve().toBodilessEntity().getStatusCode().value();
        assertThat(status).isIn(401, 404);
    }
}
