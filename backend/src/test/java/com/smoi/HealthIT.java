package com.smoi;

import java.util.Map;

import com.smoi.support.IntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.web.server.LocalManagementPort;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ResponseEntity;
import org.springframework.web.client.RestClient;

import static org.assertj.core.api.Assertions.assertThat;

class HealthIT extends IntegrationTest {

    @LocalManagementPort
    private int managementPort;

    @Test
    void healthIsUpWithoutAuthenticationOnTheManagementPort() {
        ResponseEntity<Map<String, Object>> res = RestClient.create("http://localhost:" + managementPort)
                .get().uri("/actuator/health")
                .retrieve().toEntity(new ParameterizedTypeReference<>() { });

        assertThat(res.getStatusCode().value()).isEqualTo(200);
        assertThat(res.getBody()).containsEntry("status", "UP");
    }

    @Test
    void livenessAndReadinessAreOnTheApiPortWithoutAuthentication() {
        for (String path : new String[] {"/livez", "/readyz"}) {
            ResponseEntity<Map<String, Object>> res = http().get().uri(path)
                    .retrieve().toEntity(new ParameterizedTypeReference<>() { });
            assertThat(res.getStatusCode().value()).as(path).isEqualTo(200);
            assertThat(res.getBody()).containsEntry("status", "UP");
        }
    }

    @Test
    void otherActuatorEndpointsAreNotExposed() {
        // Not public on either port: rejected (401) or not exposed at all (404). Never 200.
        int api = http().get().uri("/actuator/env").retrieve().toBodilessEntity().getStatusCode().value();
        int management = RestClient.builder().baseUrl("http://localhost:" + managementPort)
                .defaultStatusHandler(HttpStatusCode::isError, (req, r) -> { }).build()
                .get().uri("/actuator/env").retrieve().toBodilessEntity().getStatusCode().value();
        assertThat(api).isIn(401, 404);
        assertThat(management).isIn(401, 404);
    }
}
