import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader("jev_search", str(Path(__file__).with_name("jev_search")))
spec = importlib.util.spec_from_loader(loader.name, loader)
jev = importlib.util.module_from_spec(spec)
loader.exec_module(jev)


class SearchTests(unittest.TestCase):
    def test_recursive_exclusion_without_git_repository(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "sub").mkdir()
            (root / "sub" / "yes.md").write_text("日本語のテキスト")
            (root / ".gitignore").write_text("ignored.txt\n")
            (root / "ignored.txt").write_text("ignore me")
            (root / ".secret").write_text("secret")
            (root / "binary").write_bytes(b"\x00abc")
            (root / "link").symlink_to(root / "sub" / "yes.md")
            (root / "config.env").write_text("API_KEY=secret")
            files, skipped = jev.enumerate_files(root, root / "config.env")
            self.assertEqual([f["path"] for f in files], ["sub/yes.md"])
            self.assertEqual(skipped["binary"], 1)

    def test_ripgrep_config_cannot_disable_exclusion(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / ".gitignore").write_text("ignored.txt\n")
            (root / "ignored.txt").write_text("excluded fixture")
            (root / "visible.txt").write_text("included fixture")
            config = root / "rg_config"
            config.write_text("--no-ignore\n")
            with patch.dict(os.environ, {"RIPGREP_CONFIG_PATH": str(config)}):
                files, _ = jev.enumerate_files(root, config)
            self.assertEqual([f["path"] for f in files], ["visible.txt"])

    def test_auth_abort_reports_unsubmitted_chunks(self):
        files = [{"id": str(i), "path": f"{i}.md", "content": "x"} for i in range(3)]
        output = io.StringIO()
        with patch.object(jev, "snapshot", wraps=jev.snapshot) as snapshot:
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
                def unauthorized(*args):
                    raise ValueError("API HTTP 401")
                code = jev.search("query", Path("/tmp"), files, [[f] for f in files],
                                  1, "fake", True, unauthorized)
        data = json.loads(output.getvalue())
        self.assertEqual(code, 1)
        self.assertEqual(data["status"], "aborted")
        self.assertEqual(data["total_chunks"], 3)
        self.assertEqual(data["evaluated_chunks"], 0)
        self.assertEqual(data["failed_chunks"], 1)
        self.assertEqual(data["unevaluated_chunks"], 2)
        with tempfile.TemporaryDirectory() as temp:
            listing = Path(temp) / "results.tsv"
            args = list(snapshot.call_args.args)
            args[0] = listing
            jev.snapshot(*args)
            self.assertIn("打ち切り", listing.read_text())
            self.assertIn("未評価部分 2", listing.read_text())

    def test_dry_run_never_calls_api(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "sample.md").write_text("通信エラーを再試行する")
            output = io.StringIO()
            arguments = ["jev_search", "再試行", str(root), "--dry-run",
                         "--env-file", str(root / ".env")]
            with patch.object(jev.sys, "argv", arguments), patch.dict(os.environ, {"PATH": os.environ["PATH"]}, clear=True):
                with patch.object(jev.urllib.request, "urlopen", side_effect=AssertionError("network forbidden")):
                    with contextlib.redirect_stdout(output):
                        self.assertEqual(jev.main(), 0)
            self.assertIn("ファイル数: 1", output.getvalue())
            self.assertIn("リクエスト数: 1", output.getvalue())
            self.assertIn("API送信なし", output.getvalue())

    def test_split_covers_entire_file_and_respects_estimate_budget(self):
        content = "".join(f"{i:04}: 通信失敗を再試行する\n" for i in range(500))
        files = [{"id": "0", "path": "nested/file.md", "content": content}]
        batches = jev.plan("再試行", files, 1024)
        self.assertGreater(len(batches), 1)
        covered = set()
        for batch in batches:
            self.assertLessEqual(jev.request_tokens("再試行", batch), 1024)
            for chunk in batch:
                start = content.index(chunk["content"])
                covered.update(range(start, start + len(chunk["content"])))
        self.assertEqual(len(covered), len(content))

    def test_validate_response(self):
        for value in (True, -0.1, 1.1, float("nan"), "0.9", None):
            with self.assertRaises(ValueError):
                jev.parse_response({"answers": {"c0": {"type": "noul", "noul": value}}}, 1)
        self.assertEqual(jev.parse_response({"answers": {"c0": {"type": "noul", "noul": 0.9}}}, 1), ([0.9], None))

    def test_concurrency_ranking_and_failure(self):
        lock = threading.Lock()
        running = maximum = 0
        def mock(query, batch, key, stop):
            nonlocal running, maximum
            with lock:
                running += 1
                maximum = max(maximum, running)
            time.sleep(0.04)
            with lock:
                running -= 1
            if batch[0]["id"] == "3":
                raise ValueError("API HTTP 429")
            return [int(batch[0]["id"]) / 10], 100
        files = [{"id": str(i), "path": f"{i}.md", "content": "x"} for i in range(4)]
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
            code = jev.search("query", Path("/tmp"), files, [[f] for f in files], 2, "fake", True, mock)
        data = json.loads(output.getvalue())
        self.assertEqual(code, 1)
        self.assertEqual(maximum, 2)
        self.assertEqual([r["probability"] for r in data["results"]], [0.2, 0.1, 0])
        self.assertEqual(data["failed_chunks"], 1)
        self.assertEqual(data["input_tokens"], 300)

    def test_env_precedence_and_no_shell_execution(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {"JEV_CONCURRENCY": "2"}):
            file = Path(temp) / ".env"
            file.write_text('JEV_CONCURRENCY=8\nTYPESAFE_API_KEY="$(echo fake)"\n')
            jev.load_env(file)
            self.assertEqual(os.environ["JEV_CONCURRENCY"], "2")
            self.assertEqual(os.environ["TYPESAFE_API_KEY"], "$(echo fake)")

    def test_retry_and_auth_failure(self):
        from urllib.error import HTTPError
        stop = threading.Event()
        batch = [{"id": "0", "path": "a", "content": "b"}]
        ok = io.StringIO('{"answers":{"c0":{"type":"noul","noul":0.9}},"usage":{"input_tokens":20}}')
        with patch.object(jev.urllib.request, "urlopen", side_effect=[HTTPError("url", 429, "", {}, None), ok]) as call, patch.object(stop, "wait"):
            self.assertEqual(jev.evaluate("query", batch, "fake", stop), ([0.9], 20))
            self.assertEqual(call.call_count, 2)
        with patch.object(jev.urllib.request, "urlopen", side_effect=HTTPError("url", 401, "", {}, None)) as call:
            with self.assertRaisesRegex(ValueError, "401"):
                jev.evaluate("query", batch, "fake", stop)
            self.assertEqual(call.call_count, 1)


if __name__ == "__main__":
    unittest.main()
