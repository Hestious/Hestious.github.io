"""Integration checks for LaTeX conversion and archive boundaries."""
import importlib.util
import base64
from pathlib import Path
import shutil
import stat
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("build_site", ROOT / "scripts/build_site.py")
site = importlib.util.module_from_spec(spec)
spec.loader.exec_module(site)


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def zip(self, files):
        path = self.root / "source.zip"
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as z:
            for name, contents in files.items():
                z.writestr(name, contents)
        return path

    def convert(self, archive):
        destination = self.root / "article"
        report = site.convert_project(archive, {"id": "optimal-transport", "title": "Test note"}, destination)
        return (destination / "index.html").read_text(), report

    @unittest.skipUnless(shutil.which("pandoc"), "Pandoc is required")
    def test_representative_project_preserves_math_and_structure(self):
        files = {p.relative_to(ROOT / "tests/fixtures/latex-project").as_posix(): p.read_bytes()
                 for p in (ROOT / "tests/fixtures/latex-project").rglob("*") if p.is_file()}
        page, report = self.convert(self.zip(files))
        self.assertIn("An included chapter", page)
        self.assertIn("Theorem 1", page)
        self.assertIn("Proof.", page)
        self.assertIn(r"\begin{align}", page)
        self.assertIn(r"\begin{equation*}", page)
        self.assertIn(r"\eqref{eq:expectation}", page)
        self.assertIn(r"\label{eq:expectation}", page)
        self.assertIn(r"\operatorname{Tr}", page)
        self.assertNotIn(r"\Tr", page)
        self.assertNotIn("[eq:expectation]", page)
        self.assertIn("Quantum Computation and Quantum Information", page)
        self.assertNotIn("LATEXDISPLAYTOKEN", page)
        self.assertEqual(report["warnings"], [])

    def test_traversal_is_rejected(self):
        with self.assertRaisesRegex(site.ImportFailure, "Unsafe ZIP path"):
            site.extract_archive(self.zip({"../escape.tex": "bad"}), self.root / "out")
        self.assertFalse((self.root / "escape.tex").exists())

    def test_symlink_is_rejected(self):
        archive = self.root / "link.zip"
        info = zipfile.ZipInfo("main.tex")
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        with zipfile.ZipFile(archive, "w") as z:
            z.writestr(info, "/etc/passwd")
        with self.assertRaisesRegex(site.ImportFailure, "Unsupported ZIP entry"):
            site.extract_archive(archive, self.root / "out")

    def test_compression_bomb_is_rejected(self):
        with self.assertRaisesRegex(site.ImportFailure, "compression ratio"):
            site.extract_archive(self.zip({"large.tex": "x" * (2 * 1024 * 1024)}), self.root / "out")

    def test_missing_include_is_a_build_failure(self):
        archive = self.zip({"main.tex": r"\documentclass{article}\begin{document}\input{missing}\end{document}"})
        with self.assertRaisesRegex(site.ImportFailure, "Missing or out-of-project file"):
            self.convert(archive)

    def test_recursive_include_fails(self):
        archive = self.zip({"main.tex": r"\documentclass{article}\input{child}", "child.tex": r"\input{main}"})
        with self.assertRaisesRegex(site.ImportFailure, "Circular"):
            self.convert(archive)

    def test_exponential_include_expansion_is_bounded(self):
        project = self.root / "dag"
        project.mkdir()
        for index in range(20):
            (project / f"part{index}.tex").write_text((r"\input{part" + str(index + 1) + "}\n") * 2)
        (project / "part20.tex").write_text("leaf")
        with self.assertRaisesRegex(site.ImportFailure, "Expanded TeX exceeds"):
            site.expand_inputs(project / "part0.tex", project, [])

    def test_ambiguous_main_fails(self):
        for name in ("one.tex", "two.tex"):
            (self.root / name).write_text(r"\documentclass{article}")
        with self.assertRaisesRegex(site.ImportFailure, "More than one main"):
            site.find_main(self.root)

    @unittest.skipUnless(shutil.which("pandoc"), "Pandoc is required")
    def test_unknown_latex_visible_and_javascript_link_removed(self):
        page, report = self.convert(self.zip({"main.tex": r"\documentclass{article}\begin{document}Visible.\unknownthing{important}\href{javascript:alert(1)}{Click}\end{document}"}))
        self.assertIn("important", page)
        self.assertIn("Conversion notes", page)
        self.assertNotIn('href="javascript:', page)
        self.assertTrue(report["warnings"])

    @unittest.skipUnless(shutil.which("pandoc"), "Pandoc is required")
    def test_raster_figure_is_copied_and_linked(self):
        pixel = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lmEAAAAASUVORK5CYII=")
        page, report = self.convert(self.zip({
            "main.tex": r"\documentclass{article}\usepackage{graphicx}\begin{document}Figure: \includegraphics{figure.png}\end{document}",
            "figure.png": pixel,
        }))
        self.assertIn('src="media/figure.png"', page)
        self.assertEqual((self.root / "article/media/figure.png").read_bytes(), pixel)
        self.assertEqual(report["warnings"], [])

    @unittest.skipUnless(shutil.which("pandoc"), "Pandoc is required")
    def test_graphicspath_resolves_contained_relative_directories(self):
        pixel = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lmEAAAAASUVORK5CYII=")
        page, report = self.convert(self.zip({
            "project/tex/main.tex": r"\documentclass{article}\usepackage{graphicx}\graphicspath{{../figures/}{images/}}\begin{document}\includegraphics{figure}\end{document}",
            "project/figures/figure.png": pixel,
        }))
        self.assertIn('src="media/project/figures/figure.png"', page)
        self.assertEqual(report["warnings"], [])
        for declaration in (r"\graphicspath{{../../../outside/}}", r"\graphicspath{{\myfolder/}}"):
            with self.subTest(declaration=declaration):
                archive = self.zip({"main.tex": r"\documentclass{article}" + declaration + r"\begin{document}Text.\end{document}"})
                with self.assertRaises(site.ImportFailure):
                    self.convert(archive)

    @unittest.skipUnless(shutil.which("pandoc"), "Pandoc is required")
    def test_outside_image_and_bibliography_are_rejected(self):
        for body in (r"\includegraphics{/etc/passwd}", r"\bibliography{/etc/passwd}"):
            with self.subTest(body=body):
                archive = self.zip({"main.tex": r"\documentclass{article}\begin{document}" + body + r"\end{document}"})
                with self.assertRaises(site.ImportFailure):
                    self.convert(archive)

    @unittest.skipUnless(shutil.which("pandoc") and shutil.which("pdftoppm"), "Pandoc and Poppler are required")
    def test_pdf_figure_is_rendered_as_png(self):
        objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
                   b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R >>"]
        stream = b"0 0 1 rg 10 10 80 80 re f\n"
        objects.append(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"endstream")
        pdf = b"%PDF-1.4\n"
        offsets = [0]
        for index, content in enumerate(objects, 1):
            offsets.append(len(pdf))
            pdf += str(index).encode() + b" 0 obj\n" + content + b"\nendobj\n"
        xref = len(pdf)
        pdf += b"xref\n0 5\n0000000000 65535 f \n"
        pdf += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets[1:])
        pdf += b"trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n" + str(xref).encode() + b"\n%%EOF\n"
        page, report = self.convert(self.zip({
            "main.tex": r"\documentclass{article}\begin{document}\includegraphics{plot.pdf}\end{document}",
            "plot.pdf": pdf,
        }))
        self.assertIn('src="media/plot.pdf.png"', page)
        self.assertTrue((self.root / "article/media/plot.pdf.png").read_bytes().startswith(b"\x89PNG"))
        self.assertTrue(any("first page" in warning for warning in report["warnings"]))

    @unittest.skipUnless(shutil.which("pandoc"), "Pandoc is required")
    def test_failed_import_preserves_previous_build(self):
        root = self.root / "repo"
        for directory in ("assets", "notes", "content", "node_modules/mathjax/es5", "sources/optimal-transport"):
            (root / directory).mkdir(parents=True)
        (root / "node_modules/mathjax/es5/tex-svg.js").write_text("test")
        (root / "node_modules/mathjax/LICENSE").write_text("test")
        (root / "content/notes.json").write_text('[{"id":"optimal-transport","title":"Transport"}]')
        shutil.copyfile(self.zip({"main.tex": r"\documentclass{article}\input{missing}"}), root / "sources/optimal-transport/source.zip")
        output = self.root / "previous"
        output.mkdir()
        (output / "index.html").write_text("last successful build")
        with self.assertRaises(site.ImportFailure):
            site.build(root, output)
        self.assertEqual((output / "index.html").read_text(), "last successful build")


if __name__ == "__main__":
    unittest.main()
