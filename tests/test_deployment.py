"""The live publication marker identifies the content actually deployed."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("build_site", ROOT / "scripts/build_site.py")
site = importlib.util.module_from_spec(spec)
spec.loader.exec_module(site)


class DeploymentTests(unittest.TestCase):
    def test_build_publishes_the_actions_commit_with_its_content(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "repo"
            for name in ("assets", "notes", "content", "node_modules/mathjax/es5"):
                (root / name).mkdir(parents=True)
            (root / "node_modules/mathjax/es5/tex-svg.js").write_text("test renderer")
            (root / "node_modules/mathjax/LICENSE").write_text("test license")
            (root / "content/notes.json").write_text("[]")
            (root / "index.html").write_text("published content")
            output = Path(directory) / "dist"
            with patch.dict("os.environ", {"GITHUB_SHA": "a" * 40}), patch.object(site.shutil, "which", return_value="pandoc"):
                site.build(root, output)
            self.assertEqual(json.loads((output / "deployment.json").read_text()), {"commit": "a" * 40})
            self.assertEqual((output / "index.html").read_text(), "published content")


if __name__ == "__main__":
    unittest.main()
