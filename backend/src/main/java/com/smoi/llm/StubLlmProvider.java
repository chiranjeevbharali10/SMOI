package com.smoi.llm;

import java.time.Duration;
import java.util.function.Consumer;

/**
 * A fake LLM for load tests ({@code smoi.llm.provider=stub}). It waits a fixed time, then
 * returns a short answer citing the first source, without calling any model.
 *
 * <p>With a real CPU-only model, a load test only measures the model: each answer takes tens of
 * seconds and nothing else matters. The stub keeps everything else real (auth, rate limiting,
 * retrieval SQL, embeddings, prompt building, citation checks) so the test measures SMOI itself.
 * Never use it for answering real questions; it is reported as provider {@code stub} everywhere.
 */
public class StubLlmProvider implements LlmProvider {

    static final String ANSWER = "This is a stub answer for load testing, based on the first source [S1].";

    private final Duration latency;

    public StubLlmProvider(Duration latency) {
        this.latency = latency;
    }

    @Override
    public String providerId() {
        return "stub";
    }

    @Override
    public String model() {
        return "stub-" + latency.toMillis() + "ms";
    }

    @Override
    public boolean hosted() {
        return false;
    }

    @Override
    public int maxPromptTokens() {
        return 6000;
    }

    @Override
    public LlmResult generate(LlmRequest request, Consumer<String> onText) {
        long start = System.nanoTime();
        try {
            Thread.sleep(latency);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new LlmUnavailableException("Interrupted", e);
        }
        onText.accept(ANSWER);
        long ms = (System.nanoTime() - start) / 1_000_000;
        // Token counts estimated as characters / 4, like the rest of SMOI.
        return new LlmResult(ANSWER, LlmResult.Stop.COMPLETE, null, null,
                (request.system().length() + request.user().length()) / 4, ANSWER.length() / 4, ms, ms);
    }
}
