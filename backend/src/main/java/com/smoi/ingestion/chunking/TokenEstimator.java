package com.smoi.ingestion.chunking;

/**
 * Estimates how many tokens a model will see in a text. Models read text as tokens (word
 * pieces), and their limits are in tokens, not characters.
 *
 * <p>For English text, one token is about 4 characters on average. Using that rule instead of
 * the model's real tokenizer keeps chunking independent of the embedding model. A chunk can be
 * off by maybe 20%, which is fine because the limit we chunk to (about 500) is far below
 * the embedding model's context (2,048 or more).
 */
public final class TokenEstimator {

    private TokenEstimator() {
    }

    public static int estimate(String text) {
        return (text.length() + 3) / 4;
    }
}
