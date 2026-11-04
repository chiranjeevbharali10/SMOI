import unittest

from smoi_eval import email_eval


class EmailEvalTest(unittest.TestCase):

    def test_the_synthetic_set_is_balanced_and_labelled(self):
        items = email_eval.load()
        self.assertEqual(len({i["id"] for i in items}), len(items))
        counts = {c: sum(i["label"] == c for i in items) for c in email_eval.CLASSES}
        self.assertTrue(all(n >= 14 for n in counts.values()), counts)
        # Only made-up domains: no real mail in the test set.
        for i in items:
            domain = i["from"].split("@")[1]
            self.assertTrue("example" in domain, i["from"])

    def test_perfect_predictions_score_one(self):
        pairs = [(c, c) for c in email_eval.CLASSES]
        m = email_eval.metrics(pairs)
        self.assertEqual(m["macro_f1"], 1.0)
        self.assertEqual(m["accuracy"], 1.0)

    def test_per_class_precision_and_recall(self):
        pairs = [("important", "important"), ("important", "personal"), ("personal", "personal"),
                 ("academic", email_eval.UNCLASSIFIED)]
        m = email_eval.metrics(pairs)
        self.assertEqual(m["per_class"]["important"]["recall"], 0.5)
        self.assertEqual(m["per_class"]["important"]["precision"], 1.0)
        self.assertEqual(m["per_class"]["personal"]["precision"], 0.5)
        self.assertEqual(m["per_class"]["academic"]["recall"], 0.0)
        self.assertEqual(m["unclassified"], 1)
        self.assertEqual(m["confusion"]["academic"][email_eval.UNCLASSIFIED], 1)


if __name__ == "__main__":
    unittest.main()
