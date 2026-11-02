package com.smoi.retrieval;

import java.util.List;
import java.util.UUID;
import java.util.stream.IntStream;

import com.smoi.auth.CurrentUser;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Retrieval only, without an LLM: the ranked chunks for a query. Phase 3 measures retrieval
 * quality through this endpoint, and it is useful for seeing what an answer would be based on.
 */
@RestController
@RequestMapping("/api/search")
public class SearchController {

    private final RetrievalService retrieval;

    public SearchController(RetrievalService retrieval) {
        this.retrieval = retrieval;
    }

    @PostMapping
    public SearchResponse search(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody SearchRequest request) {
        RetrievalMode mode = request.mode() == null ? RetrievalMode.HYBRID : request.mode();
        int topK = request.topK() == null ? 10 : request.topK();
        RetrievalResult result = retrieval.retrieve(CurrentUser.id(jwt), request.query(), mode, topK, false);
        return new SearchResponse(result.mode(), result.rerank(), result.rerankNote(), result.rerankModel(),
                result.timings(), IntStream.range(0, result.chunks().size())
                        .mapToObj(i -> SearchHit.from(i + 1, result.chunks().get(i))).toList());
    }

    public record SearchRequest(@NotBlank @Size(max = 2000) String query, RetrievalMode mode,
                                @Min(1) @Max(50) Integer topK) {
    }

    public record SearchResponse(RetrievalMode mode, String rerank, String rerankNote, String rerankModel,
                                 RetrievalResult.Timings timings, List<SearchHit> results) {
    }

    public record SearchHit(int rank, UUID chunkId, UUID documentId, String filename, int chunkIndex,
                            Integer pageStart, Integer pageEnd, String section, double score,
                            Integer keywordRank, Integer vectorRank, String content) {

        static SearchHit from(int rank, RetrievedChunk c) {
            return new SearchHit(rank, c.chunkId(), c.documentId(), c.filename(), c.chunkIndex(), c.pageStart(),
                    c.pageEnd(), c.section(), c.score(), c.keywordRank(), c.vectorRank(), c.content());
        }
    }
}
