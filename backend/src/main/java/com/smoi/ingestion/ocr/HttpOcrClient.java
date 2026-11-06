package com.smoi.ingestion.ocr;

import java.net.http.HttpClient;
import java.util.List;

import com.smoi.resilience.ProviderTimeouts;
import org.springframework.http.MediaType;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

/** Calls the OCR sidecar ({@code sidecars/ocr}): {@code POST /ocr} with the PDF bytes. */
public class HttpOcrClient implements OcrClient {

    private final RestClient http;

    public HttpOcrClient(OcrProperties props) {
        HttpClient client = HttpClient.newBuilder().connectTimeout(ProviderTimeouts.CONNECT).build();
        JdkClientHttpRequestFactory requestFactory = new JdkClientHttpRequestFactory(client);
        requestFactory.setReadTimeout(props.timeout());
        this.http = RestClient.builder().baseUrl(props.baseUrl()).requestFactory(requestFactory).build();
    }

    @Override
    public List<String> recognise(byte[] pdf) {
        OcrResponse response;
        try {
            response = http.post().uri("/ocr")
                    .contentType(MediaType.APPLICATION_PDF)
                    .body(pdf)
                    .retrieve()
                    .body(OcrResponse.class);
        } catch (RestClientException e) {
            // Not a parse error: the sidecar may be starting or busy, so the job is retried.
            throw new OcrUnavailableException("OCR request failed: " + e.getMessage(), e);
        }
        if (response == null || response.pages() == null) {
            throw new OcrUnavailableException("OCR sidecar returned no pages", null);
        }
        return response.pages();
    }

    record OcrResponse(List<String> pages) {
    }

    public static class OcrUnavailableException extends RuntimeException {
        public OcrUnavailableException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}
