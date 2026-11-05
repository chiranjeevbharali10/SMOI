"""Unit tests for the file-level brain eval. Run with: python -m unittest discover -s eval/tests"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from smoi_eval import brain  # noqa: E402
from smoi_eval.brain import BrainQuery  # noqa: E402


def hit(filename, page_start=None, page_end=None, score=0.5):
    return {"filename": filename, "pageStart": page_start, "pageEnd": page_end, "score": score}


class FileRankTest(unittest.TestCase):

    def test_rank_counts_distinct_files_not_chunks(self):
        results = [hit("a.txt"), hit("a.txt"), hit("a.txt"), hit("b.pdf")]
        self.assertEqual(brain.file_rank(results, "b.pdf"), 2)

    def test_missing_file_has_no_rank(self):
        self.assertIsNone(brain.file_rank([hit("a.txt")], "b.pdf"))

    def test_page_must_be_inside_a_returned_chunk_of_the_file(self):
        results = [hit("a.pdf", 1, 2), hit("b.pdf", 4, 5)]
        self.assertEqual(brain.file_rank(results, "b.pdf", 5), 2)
        self.assertIsNone(brain.file_rank(results, "b.pdf", 3))
        self.assertIsNone(brain.file_rank([hit("b.txt")], "b.txt", 1))


class ValidateTest(unittest.TestCase):
    known = {"a.txt"}

    def test_the_shipped_set_is_valid(self):
        queries = brain.load()
        self.assertEqual(brain.validate(queries), [])
        self.assertTrue(30 <= len(queries) <= 50)
        self.assertEqual({q.category for q in queries}, set(brain.CATEGORIES))

    def test_problems_are_reported(self):
        queries = [BrainQuery("x", "exact", "q", "missing.txt", None),
                   BrainQuery("x", "no_result", "q", "a.txt", None),
                   BrainQuery("y", "other", "q", "a.txt", 0),
                   BrainQuery("z", "paraphrase", "q", None, None)]
        problems = brain.validate(queries, self.known)
        self.assertEqual(len(problems), 6, problems)


class SummarizeTest(unittest.TestCase):

    def test_recall_mrr_and_no_result_share(self):
        rows = [
            {"id": "1", "category": "exact", "rank": 1, "recall@5": 1.0, "mrr@10": 1.0, "wall_ms": 10, "server_ms": 8, "rerank": None},
            {"id": "2", "category": "paraphrase", "rank": 4, "recall@5": 1.0, "mrr@10": 0.25, "wall_ms": 20, "server_ms": 18, "rerank": None},
            {"id": "3", "category": "filename", "rank": None, "recall@5": 0.0, "mrr@10": 0.0, "wall_ms": 30, "server_ms": 28, "rerank": None},
            {"id": "4", "category": "no_result", "correctly_empty": 0.0, "wall_ms": 40, "server_ms": 38, "rerank": None},
        ]
        s = brain.summarize({"hybrid": rows})["hybrid"]
        self.assertAlmostEqual(s["overall"]["recall@5"], 2 / 3)
        self.assertAlmostEqual(s["overall"]["mrr@10"], 1.25 / 3)
        self.assertEqual(s["no_result"], {"queries": 1, "correctly_empty": 0.0})
        self.assertEqual(s["latency_ms"]["wall_mean"], 25)
        self.assertEqual(brain.misses({"hybrid": rows}), {"hybrid": ["3", "4"]})


if __name__ == "__main__":
    unittest.main()
