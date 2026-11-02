package com.smoi.retrieval;

import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class ReciprocalRankFusionTest {

    private static RetrievedChunk chunk(String name) {
        UUID id = UUID.nameUUIDFromBytes(name.getBytes());
        return new RetrievedChunk(id, UUID.randomUUID(), name + ".txt", 0, name, null, null, null, 0, null, null);
    }

    private static final RetrievedChunk A = chunk("a");
    private static final RetrievedChunk B = chunk("b");
    private static final RetrievedChunk C = chunk("c");
    private static final RetrievedChunk D = chunk("d");

    @Test
    void scoreIsTheSumOfReciprocalRanks() {
        List<RetrievedChunk> fused = ReciprocalRankFusion.fuse(List.of(A, B), List.of(B, C), 60);

        RetrievedChunk b = fused.stream().filter(c -> c.chunkId().equals(B.chunkId())).findFirst().orElseThrow();
        assertThat(b.score()).isCloseTo(1.0 / 62 + 1.0 / 61, within(1e-12));
        assertThat(b.keywordRank()).isEqualTo(2);
        assertThat(b.vectorRank()).isEqualTo(1);
    }

    @Test
    void agreementBeatsASingleFirstPlace() {
        // A is first in keyword only. C is 2nd in both lists. With k = 60, agreement wins.
        List<RetrievedChunk> fused = ReciprocalRankFusion.fuse(List.of(A, C), List.of(D, C), 60);

        assertThat(fused.getFirst().chunkId()).isEqualTo(C.chunkId());
    }

    @Test
    void chunksFromOnlyOneListAreKeptWithTheOtherRankEmpty() {
        List<RetrievedChunk> fused = ReciprocalRankFusion.fuse(List.of(A), List.of(D), 60);

        assertThat(fused).hasSize(2);
        assertThat(fused).filteredOn(c -> c.chunkId().equals(A.chunkId()))
                .singleElement().satisfies(c -> assertThat(c.vectorRank()).isNull());
    }

    @Test
    void emptyListsGiveAnEmptyResult() {
        assertThat(ReciprocalRankFusion.fuse(List.of(), List.of(), 60)).isEmpty();
    }
}
