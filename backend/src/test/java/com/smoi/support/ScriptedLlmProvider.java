package com.smoi.support;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import java.util.function.Function;

import com.smoi.llm.LlmProvider;
import com.smoi.llm.LlmRequest;
import com.smoi.llm.LlmResult;

/**
 * A deterministic stand-in for the LLM in integration tests. It records every prompt it gets,
 * so tests can check exactly what would have been sent to a model, and replies with whatever
 * the test scripted. By default it answers citing the first source.
 */
public class ScriptedLlmProvider implements LlmProvider {

    public static final Function<LlmRequest, LlmResult> CITE_FIRST_SOURCE = r -> complete("Based on your notes, here is the answer [S1].");

    private final List<LlmRequest> requests = new CopyOnWriteArrayList<>();
    private volatile Function<LlmRequest, LlmResult> responder = CITE_FIRST_SOURCE;
    private volatile boolean hosted;
    private volatile int maxPromptTokens = 6000;

    public static LlmResult complete(String text) {
        return new LlmResult(text, LlmResult.Stop.COMPLETE, null, null, 100, 20, 5, 10);
    }

    public static LlmResult refusal(String category) {
        return new LlmResult("", LlmResult.Stop.REFUSAL, category, "Declined by policy", 100, 0, 0, 10);
    }

    public void reply(Function<LlmRequest, LlmResult> newResponder) {
        responder = newResponder;
    }

    public void replyWith(String text) {
        responder = r -> complete(text);
    }

    public void setHosted(boolean value) {
        hosted = value;
    }

    public void setMaxPromptTokens(int value) {
        maxPromptTokens = value;
    }

    public List<LlmRequest> requests() {
        return List.copyOf(requests);
    }

    public void reset() {
        requests.clear();
        responder = CITE_FIRST_SOURCE;
        hosted = false;
        maxPromptTokens = 6000;
    }

    @Override
    public String providerId() {
        return "scripted";
    }

    @Override
    public String model() {
        return "scripted-test-model";
    }

    @Override
    public boolean hosted() {
        return hosted;
    }

    @Override
    public int maxPromptTokens() {
        return maxPromptTokens;
    }

    @Override
    public LlmResult generate(LlmRequest request, Consumer<String> onText) {
        requests.add(request);
        LlmResult result = responder.apply(request);
        // Stream the reply word by word, like a real provider.
        for (String piece : result.text().split("(?<= )")) {
            if (!piece.isEmpty()) {
                onText.accept(piece);
            }
        }
        return result;
    }
}
