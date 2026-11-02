package com.smoi.llm;

import java.util.Locale;
import java.util.function.Consumer;

import com.anthropic.client.AnthropicClient;
import com.anthropic.client.okhttp.AnthropicOkHttpClient;
import com.anthropic.core.http.StreamResponse;
import com.anthropic.errors.AnthropicIoException;
import com.anthropic.errors.AnthropicServiceException;
import com.anthropic.helpers.MessageAccumulator;
import com.anthropic.models.messages.Message;
import com.anthropic.models.messages.MessageCreateParams;
import com.anthropic.models.messages.OutputConfig;
import com.anthropic.models.messages.RawMessageStreamEvent;
import com.anthropic.models.messages.StopReason;

/**
 * Claude through the official Anthropic Java SDK. Opt-in: only used when
 * {@code smoi.llm.provider=anthropic}, and only documents the user allowed for hosted LLMs are
 * sent to it.
 *
 * <p>Model-specific choices for Claude Haiku 5.5 (the default model):
 * <ul>
 *   <li>No {@code temperature}, {@code top_p} or {@code top_k}: Haiku 5.5 rejects them.</li>
 *   <li>Thinking is left at the model's default (adaptive), and {@code effort} controls how much
 *       it thinks. Thinking counts toward {@code max_tokens}, so the output limit leaves room for it.
 *       Only text blocks are read from the reply.</li>
 *   <li>A refusal is HTTP 200 with {@code stop_reason: "refusal"}. It is reported as its own result,
 *       never as an answer. Haiku has no server-side fallback model, so none is configured.</li>
 * </ul>
 */
public class AnthropicLlmProvider implements LlmProvider {

    private final AnthropicClient client;
    private final LlmProperties.Anthropic props;
    private final int maxOutputTokens;

    public AnthropicLlmProvider(LlmProperties.Anthropic props, int maxOutputTokens) {
        if (props.apiKey() == null || props.apiKey().isBlank()) {
            throw new IllegalStateException("smoi.llm.provider=anthropic needs ANTHROPIC_API_KEY");
        }
        this.props = props;
        this.maxOutputTokens = maxOutputTokens;
        this.client = AnthropicOkHttpClient.builder()
                .apiKey(props.apiKey())
                .timeout(props.timeout())
                .build();
    }

    @Override
    public String providerId() {
        return "anthropic";
    }

    @Override
    public String model() {
        return props.model();
    }

    @Override
    public boolean hosted() {
        return true;
    }

    @Override
    public int maxPromptTokens() {
        return props.maxPromptTokens();
    }

    @Override
    public LlmResult generate(LlmRequest request, Consumer<String> onText) {
        MessageCreateParams params = MessageCreateParams.builder()
                .model(props.model())
                .maxTokens(maxOutputTokens)
                .system(request.system())
                .addUserMessage(request.user())
                .outputConfig(OutputConfig.builder().effort(effort(props.effort())).build())
                .build();

        long start = System.nanoTime();
        long[] firstTokenMs = {-1};
        MessageAccumulator accumulator = MessageAccumulator.create();
        try (StreamResponse<RawMessageStreamEvent> stream = client.messages().createStreaming(params)) {
            stream.stream().forEach(event -> {
                accumulator.accumulate(event);
                event.contentBlockDelta().flatMap(d -> d.delta().text()).ifPresent(delta -> {
                    if (firstTokenMs[0] < 0) {
                        firstTokenMs[0] = millisSince(start);
                    }
                    onText.accept(delta.text());
                });
            });
        } catch (AnthropicServiceException e) {
            throw new LlmUnavailableException("Claude API error " + e.statusCode() + ": " + e.getMessage(), e);
        } catch (AnthropicIoException e) {
            throw new LlmUnavailableException("Could not reach the Claude API: " + e.getMessage(), e);
        }

        Message message = accumulator.message();
        String text = message.content().stream()
                .flatMap(block -> block.text().stream())
                .map(t -> t.text())
                .reduce("", String::concat);
        StopReason reason = message.stopReason().orElse(StopReason.END_TURN);
        long inputTokens = message.usage().inputTokens();
        long outputTokens = message.usage().outputTokens();
        long total = millisSince(start);

        if (reason.equals(StopReason.REFUSAL)) {
            String category = message.stopDetails().flatMap(d -> d.category()).map(Object::toString).orElse(null);
            String explanation = message.stopDetails().flatMap(d -> d.explanation()).orElse(null);
            return new LlmResult(text, LlmResult.Stop.REFUSAL, category, explanation, inputTokens, outputTokens,
                    Math.max(firstTokenMs[0], 0), total);
        }
        if (reason.equals(StopReason.MODEL_CONTEXT_WINDOW_EXCEEDED)) {
            throw new ContextOverflowException("The prompt exceeded the model's context window");
        }
        LlmResult.Stop stop = reason.equals(StopReason.MAX_TOKENS) ? LlmResult.Stop.MAX_TOKENS : LlmResult.Stop.COMPLETE;
        return new LlmResult(text, stop, null, null, inputTokens, outputTokens, Math.max(firstTokenMs[0], 0), total);
    }

    private static OutputConfig.Effort effort(String value) {
        return switch (value.toLowerCase(Locale.ROOT)) {
            case "low" -> OutputConfig.Effort.LOW;
            case "medium" -> OutputConfig.Effort.MEDIUM;
            case "high" -> OutputConfig.Effort.HIGH;
            default -> throw new IllegalStateException("smoi.llm.anthropic.effort must be low, medium or high");
        };
    }

    private static long millisSince(long start) {
        return (System.nanoTime() - start) / 1_000_000;
    }
}
