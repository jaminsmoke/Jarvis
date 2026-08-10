import importlib.util
import pathlib
import unittest


SPEC = importlib.util.spec_from_file_location(
    "upstream_report",
    pathlib.Path(__file__).parents[1] / "upstream-report.py",
)
upstream_report = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(upstream_report)


class ParseRevListCountTest(unittest.TestCase):
    def test_parses_two_counts(self):
        self.assertEqual(upstream_report.parse_rev_list_count("4\t64\n"), (4, 64))

    def test_raises_on_garbage(self):
        with self.assertRaises(ValueError):
            upstream_report.parse_rev_list_count("not numbers")


class ParseCommitsTest(unittest.TestCase):
    def test_parses_oneline_log(self):
        raw = "0bff28de0 fix(stats): fall back after full sync failure (#41411)\n"
        raw += "38e10eb14 fix(opencode): ignore unknown config fields (#41312)\n"
        commits = upstream_report.parse_commits(raw)
        self.assertEqual(len(commits), 2)
        self.assertEqual(commits[0][0], "0bff28de0")
        self.assertIn("fix(stats)", commits[0][1])

    def test_empty_log(self):
        self.assertEqual(upstream_report.parse_commits(""), [])


class ClassifyCommitTest(unittest.TestCase):
    def test_generate_subject_is_excluded(self):
        commit = upstream_report.classify_commit("abc", "chore: generate", ["packages/app/x.ts"])
        self.assertTrue(commit.excludable)
        self.assertIn("generate", commit.exclude_reason)

    def test_workflow_file_is_excluded(self):
        commit = upstream_report.classify_commit(
            "abc", "fix(ci): something", [".github/workflows/typecheck.yml"]
        )
        self.assertTrue(commit.excludable)
        self.assertIn("workflows", commit.exclude_reason)

    def test_dependency_bump_is_excluded(self):
        commit = upstream_report.classify_commit("abc", "chore(deps): bump x", ["package.json", "bun.lock"])
        self.assertTrue(commit.excludable)
        self.assertIn("dependencias", commit.exclude_reason)

    def test_plain_fix_is_candidate(self):
        commit = upstream_report.classify_commit(
            "abc", "fix(stats): fall back after failure", ["packages/stats/server/src/stat-sync.ts"]
        )
        self.assertFalse(commit.excludable)

    def test_case_insensitive_generate(self):
        commit = upstream_report.classify_commit("abc", "chore: Generate SDK", ["packages/sdk/x.ts"])
        self.assertTrue(commit.excludable)


class BuildReportTest(unittest.TestCase):
    def test_report_contains_counts_and_markers(self):
        commits = [
            upstream_report.classify_commit("abc", "fix(stats): fallback", ["packages/stats/x.ts"]),
            upstream_report.classify_commit("def", "chore: generate", ["packages/sdk/y.ts"]),
        ]
        report = upstream_report.build_report(behind=2, ahead=64, commits=commits)
        self.assertIn("Behind", report)
        self.assertIn("`2`", report)
        self.assertIn("Ahead", report)
        self.assertIn("`64`", report)
        self.assertIn("[candidato]", report)
        self.assertIn("[EXCLUIDO]", report)
        self.assertIn("Candidatos**: 1 de 2", report)


if __name__ == "__main__":
    unittest.main()
