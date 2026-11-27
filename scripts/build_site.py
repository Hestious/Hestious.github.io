#!/usr/bin/env python3
"""Build a static research site, converting owner-uploaded LaTeX ZIP projects.

TeX is parsed by Pandoc, never compiled with shell escape. Archive contents are
extracted into a bounded temporary directory; Pandoc runs with --sandbox after
local includes have been expanded. A failed import leaves the last build intact.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import html
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tempfile
from urllib.parse import quote, urlsplit
import zipfile

ROOT = Path(__file__).resolve().parents[1]
MAX_ARCHIVE = 25 * 1024 * 1024
MAX_EXPANDED = 100 * 1024 * 1024
MAX_FILE = 30 * 1024 * 1024
MAX_ENTRIES = 1500
DISPLAY = re.compile(r"\\begin\{(equation\*?|align\*?|alignat\*?|gather\*?|multline\*?|eqnarray\*?)\}")
SAFE_ID = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")


class ImportFailure(RuntimeError):
    pass


def inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def extract_archive(archive: Path, destination: Path) -> None:
    if archive.stat().st_size > MAX_ARCHIVE:
        raise ImportFailure("ZIP exceeds the 25 MB upload limit.")
    try:
        with zipfile.ZipFile(archive) as z:
            entries = z.infolist()
            if len(entries) > MAX_ENTRIES:
                raise ImportFailure("ZIP contains too many files (maximum 1,500).")
            total = 0
            seen = set()
            for item in entries:
                name = item.filename
                path = PurePosixPath(name)
                if (not name or "\\" in name or "\x00" in name or path.is_absolute()
                        or ".." in path.parts or re.match(r"^[A-Za-z]:", name)):
                    raise ImportFailure(f"Unsafe ZIP path: {name!r}")
                if name in seen:
                    raise ImportFailure(f"Duplicate ZIP path: {name}")
                seen.add(name)
                mode = item.external_attr >> 16
                if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                    raise ImportFailure(f"Unsupported ZIP entry: {name}")
                if item.flag_bits & 1:
                    raise ImportFailure("Encrypted ZIP files are not supported.")
                total += item.file_size
                if item.file_size > MAX_FILE or total > MAX_EXPANDED:
                    raise ImportFailure("Expanded ZIP is too large (30 MB per file; 100 MB total).")
                if item.file_size > 1024 * 1024 and item.file_size > max(1, item.compress_size) * 200:
                    raise ImportFailure("ZIP compression ratio is too high.")
                target = destination.joinpath(*path.parts)
                if not inside(target, destination):
                    raise ImportFailure(f"Unsafe ZIP path: {name}")
                if item.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with z.open(item) as source, target.open("wb") as output:
                        copied = 0
                        while data := source.read(65536):
                            copied += len(data)
                            if copied > item.file_size or copied > MAX_FILE:
                                raise ImportFailure("ZIP expansion exceeded its declared size.")
                            output.write(data)
    except (zipfile.BadZipFile, OSError, RuntimeError) as error:
        if isinstance(error, ImportFailure):
            raise
        raise ImportFailure(f"Cannot read ZIP: {error}") from error


def read_tex(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as error:
        raise ImportFailure(f"Cannot read {path.name}; save source files as UTF-8: {error}") from error


def uncomment(source: str) -> str:
    # A percent preceded by an odd number of backslashes is an escaped percent.
    result = []
    for line in source.splitlines(keepends=True):
        for pos, char in enumerate(line):
            if char != "%":
                continue
            backslashes = 0
            cursor = pos - 1
            while cursor >= 0 and line[cursor] == "\\":
                backslashes += 1
                cursor -= 1
            if backslashes % 2 == 0:
                line = line[:pos] + ("\n" if line.endswith("\n") else "")
                break
        result.append(line)
    return "".join(result)


def find_main(root: Path) -> Path:
    files = sorted(p for p in root.rglob("*.tex") if "__MACOSX" not in p.parts)
    if not files:
        raise ImportFailure("The ZIP contains no .tex files.")
    documents = [p for p in files if re.search(r"\\documentclass(?:\[[^\]]*\])?\s*\{", uncomment(read_tex(p)))]
    preferred = [p for p in documents if p.name.lower() in ("main.tex", "root.tex")]
    if len(preferred) == 1:
        return preferred[0]
    if len(documents) == 1:
        return documents[0]
    if len(documents) > 1:
        raise ImportFailure("More than one main document found. Keep one main.tex (or root.tex) with \\documentclass.")
    if len(files) == 1:
        return files[0]
    raise ImportFailure("Cannot identify the main document. Name it main.tex and include \\documentclass.")


def local_file(name: str, current: Path, root: Path, suffix: str = "") -> Path:
    name = name.strip().strip('"')
    if not name or "\\" in name or urlsplit(name).scheme or Path(name).is_absolute():
        raise ImportFailure(f"Unsupported external or computed file path: {name!r}")
    candidates = [current / name, root / name]
    if suffix and not Path(name).suffix:
        candidates = [p.with_suffix(suffix) for p in candidates] + candidates
    for candidate in candidates:
        if not inside(candidate, root):
            continue
        if candidate.is_file():
            return candidate.resolve()
    raise ImportFailure(f"Missing or out-of-project file: {name}")


def expand_inputs(path: Path, root: Path, warnings: list[str], stack: tuple[Path, ...] = (), budget=None) -> str:
    if budget is None:
        budget = {"files": 0, "bytes": 0}
    if path in stack or len(stack) > 35:
        raise ImportFailure(f"Circular or excessively nested include: {path.name}")
    source = uncomment(read_tex(path))
    budget["files"] += 1
    budget["bytes"] += len(source.encode("utf-8"))
    if budget["files"] > 1500 or budget["bytes"] > 20 * 1024 * 1024:
        raise ImportFailure("Expanded TeX exceeds the limit (20 MB of text or 1,500 include operations).")
    # These primitives are not needed for semantic document conversion.
    if re.search(r"\\(?:write18|openin|openout|readline)\b|\\input\s*\|", source):
        raise ImportFailure("Source contains an unsupported file or shell-execution primitive.")

    def include(match):
        child = local_file(match.group(2) or match.group(3), path.parent, root, ".tex")
        return "\n" + expand_inputs(child, root, warnings, stack + (path,), budget) + "\n"

    source = re.sub(r"\\(input|include|subfile)(?![A-Za-z@])\s*(?:\{([^{}]+)\}|([^\s{}%]+))", include, source)
    if re.search(r"\\(?:input|include|subfile)\b", source):
        raise ImportFailure("An include uses a computed filename; use a literal \\input{file.tex} path.")

    def package(match):
        names = match.group(2).split(",")
        retained, definitions = [], []
        for name in names:
            name = name.strip()
            if (path.parent / (name + ".sty")).is_file() or (root / (name + ".sty")).is_file():
                child = local_file(name, path.parent, root, ".sty")
                definitions.append(expand_inputs(child, root, warnings, stack + (path,), budget))
                warnings.append(f"Custom package {name}.sty was parsed; review its formatting and custom commands.")
            else:
                retained.append(name)
        declaration = "\\usepackage" + (match.group(1) or "") + "{" + ",".join(retained) + "}" if retained else ""
        return declaration + "\n" + "\n".join(definitions)

    return re.sub(r"\\usepackage(\[[^\]]*\])?\s*\{([^{}]+)\}", package, source)


def protect_displays(source: str) -> tuple[str, dict[str, str], set[str]]:
    """Keep source equation/align numbering instead of Pandoc's lossy aligned form."""
    environments, labels = {}, set()
    cursor, pieces = 0, []
    while match := DISPLAY.search(source, cursor):
        environment = match.group(1)
        end = "\\end{" + environment + "}"
        stop = source.find(end, match.end())
        if stop < 0:
            raise ImportFailure(f"Unclosed {environment} environment.")
        body = source[match.end():stop]
        if DISPLAY.search(body):
            raise ImportFailure("Nested display-math environments are invalid; use aligned or split inside equation.")
        marker = "LATEXDISPLAYTOKEN" + str(len(environments)).zfill(6)
        environments[marker] = environment
        labels.update(re.findall(r"\\label\s*\{([^{}]+)\}", body))
        pieces.extend([source[cursor:match.start()], r"\[\text{" + marker + "}" + body + r"\]"])
        cursor = stop + len(end)
    pieces.append(source[cursor:])
    return "".join(pieces), environments, labels


def run(command: list[str], cwd: Path, warnings: list[str], timeout: int = 90) -> str:
    try:
        result = subprocess.run(command, cwd=cwd, text=True, capture_output=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ImportFailure(f"Conversion command failed: {error}") from error
    if result.returncode:
        raise ImportFailure(result.stderr.strip() or f"Command failed: {command[0]}")
    if result.stderr.strip():
        ignored = {"[WARNING] Could not load translations for en-US", "data file translations/en.yaml not found", "[WARNING] The term Abstract has no translation defined."}
        warnings.extend(line for line in result.stderr.splitlines() if line.strip() and line.strip() not in ignored)
    return result.stdout


def graphics_paths(source: str, main: Path, project: Path) -> tuple[str, list[Path]]:
    directories = []

    def declaration(match):
        for name in re.findall(r"\{([^{}]*)\}", match.group(1)):
            name = name.strip()
            if "\\" in name or "#" in name or urlsplit(name).scheme or Path(name).is_absolute():
                raise ImportFailure(f"Use literal project directories in \\graphicspath: {name!r}")
            candidates = [(main.parent / name).resolve(), (project / name).resolve()]
            allowed = [candidate for candidate in candidates if inside(candidate, project)]
            if not allowed:
                raise ImportFailure(f"Graphics directory is outside the ZIP project: {name}")
            directories.extend(allowed)
        return ""

    source = re.sub(r"\\graphicspath\s*\{((?:\{[^{}]*\}\s*)+)\}", declaration, source)
    if re.search(r"\\graphicspath\b", source):
        raise ImportFailure("Use literal directories such as \\graphicspath{{images/}{figures/}}.")
    return source, list(dict.fromkeys(directories))


def image_target(name: str, project: Path, main: Path, article: Path, warnings: list[str], graphic_dirs=()) -> str | None:
    if urlsplit(name).scheme or name.startswith("//"):
        warnings.append(f"External image omitted: {name}. Include the image inside the ZIP.")
        return None
    candidates = []
    names = [name] if Path(name).suffix else [name + suffix for suffix in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf", ".svg")]
    for directory in [main.parent, *graphic_dirs]:
        for filename in names:
            try:
                candidate = local_file(filename, directory, project)
                if candidate not in candidates:
                    candidates.append(candidate)
            except ImportFailure:
                pass
        if candidates:
            break
    if len(candidates) != 1:
        raise ImportFailure(f"Image is missing, outside the project, or ambiguous: {name}")
    source = candidates[0]
    relative = source.relative_to(project)
    target = article / "media" / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.suffix.lower() == ".pdf":
        target = target.with_suffix(".pdf.png")
        run(["pdftoppm", "-f", "1", "-singlefile", "-scale-to", "2200", "-png", str(source), str(target.with_suffix(""))], project, warnings)
        warnings.append(f"PDF figure {relative} is shown as its first page; keep the PDF for vector-quality or additional pages.")
    elif source.suffix.lower() in (".png", ".jpg", ".jpeg", ".gif", ".webp"):
        shutil.copyfile(source, target)
    else:
        warnings.append(f"Figure {relative} uses an unsupported image format. Export it as PNG, JPEG, or PDF.")
        return None
    return quote(target.relative_to(article).as_posix(), safe="/")


def transform_ast(value, environments, equation_labels, project, main, article, warnings, graphic_dirs=()):
    if isinstance(value, list):
        return [transform_ast(x, environments, equation_labels, project, main, article, warnings, graphic_dirs) for x in value]
    if not isinstance(value, dict):
        return value
    kind, content = value.get("t"), value.get("c")
    if kind == "Math" and content[0]["t"] == "DisplayMath":
        marker = re.search(r"\\text\{(LATEXDISPLAYTOKEN\d+)\}", content[1])
        if marker:
            env = environments[marker.group(1)]
            body = content[1].replace(marker.group(0), "", 1)
            tex = "\\begin{" + env + "}" + body + "\\end{" + env + "}"
            return {"t": "RawInline", "c": ["html", '<span class="math display">' + html.escape(tex) + '</span>']}
    if kind == "Link":
        attrs, inlines, target = content
        attributes = dict(attrs[2])
        label = attributes.get("reference", attributes.get("data-reference"))
        if label in equation_labels:
            command = "eqref" if attributes.get("reference-type", attributes.get("data-reference-type")) == "eqref" else "ref"
            return {"t": "Math", "c": [{"t": "InlineMath"}, "\\" + command + "{" + label + "}"]}
        parsed = urlsplit(target[0])
        if parsed.scheme.lower() not in ("", "https", "http", "mailto") or target[0].startswith("//"):
            warnings.append("An unsupported link URL was omitted.")
            return {"t": "Span", "c": [["", [], []], inlines]}
    if kind == "Image":
        name = image_target(content[2][0], project, main, article, warnings, graphic_dirs)
        if name is None:
            return {"t": "Str", "c": "[Figure omitted; see conversion notes.]"}
        content[2][0] = name
    if kind in ("RawInline", "RawBlock"):
        if kind == "RawInline" and content[0] == "latex":
            reference = re.fullmatch(r"\\(eqref|ref)\s*\{([^{}]+)\}", content[1])
            if reference and reference.group(2) in equation_labels:
                return {"t": "Math", "c": [{"t": "InlineMath"}, content[1]]}
        warnings.append("An unsupported LaTeX construct is displayed as source; review the conversion notes and original PDF.")
        return {"t": "Code" if kind == "RawInline" else "CodeBlock", "c": [["", ["unconverted-latex"], []], content[1]]}
    return {key: transform_ast(item, environments, equation_labels, project, main, article, warnings, graphic_dirs)
            for key, item in value.items()}


ARTICLE_CSS = """
:root{color-scheme:light;font-family:Georgia,'Times New Roman',serif;color:#21353b;background:#fbfdfc}*{box-sizing:border-box}body{margin:0;font-size:18px;line-height:1.75}header,main,footer{max-width:54rem;margin:auto;padding:1.5rem 1.4rem}header{font-family:system-ui,sans-serif;border-bottom:1px solid #dbe4e1;font-size:.9rem}header a{margin-right:1.5rem}a{color:#246961;text-underline-offset:3px}h1,h2,h3{line-height:1.25;margin-top:2rem}h1{font-size:2.2rem}h2{font-size:1.6rem}p{overflow-wrap:anywhere}img{max-width:100%;height:auto}figure{margin:2rem 0;text-align:center}figcaption{font-size:.9rem;color:#536461}table{border-collapse:collapse;display:block;overflow:auto;max-width:100%}td,th{padding:.45rem .7rem;border-bottom:1px solid #dbe4e1}.math.display{display:block;overflow-x:auto;overflow-y:hidden;margin:1.4rem 0;padding:1rem .4rem}mjx-container{max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:1rem;background:#edf2f0;border-radius:.4rem;font-size:.85rem}code{font-size:.88em}.theorem,.lemma,.proposition,.definition,.corollary{border-left:3px solid #5b8a80;padding:.2rem 1rem;margin:1.5rem 0}.proof{padding:.2rem 1rem}.conversion-notice{background:#f1f5f3;border:1px solid #d4e1db;padding:1rem;margin:1.5rem 0;font: .88rem/1.6 system-ui,sans-serif}.conversion-notice summary{cursor:pointer;font-weight:600}#math-status{font:.85rem/1.5 system-ui,sans-serif;color:#647770}footer{font: .85rem/1.6 system-ui,sans-serif;border-top:1px solid #dbe4e1;margin-top:3rem}#TOC{font: .95rem/1.6 system-ui,sans-serif;padding:1rem;background:#f1f5f3}.unconverted-latex{color:#6d3f24}@media(max-width:600px){body{font-size:17px}h1{font-size:1.8rem}header,main,footer{padding:1.2rem}}
"""


def convert_project(archive: Path, note: dict, article: Path) -> dict:
    article.mkdir(parents=True, exist_ok=True)
    warnings = []
    with tempfile.TemporaryDirectory(prefix="latex-import-") as temporary:
        project = Path(temporary)
        extract_archive(archive, project)
        main = find_main(project)
        source = expand_inputs(main, project, warnings)
        source, graphic_dirs = graphics_paths(source, main, project)
        if re.search(r"\\(?:includeonly|import|subimport)\b", source):
            raise ImportFailure("Use \\input or \\include with literal paths instead of includeonly/import/subimport.")
        source, environments, labels = protect_displays(source)
        expanded = project / "_web_import_expanded.tex"
        expanded.write_text(source, encoding="utf-8")
        bibliography = []
        for match in re.finditer(r"\\(?:bibliography|addbibresource)(?:\[[^\]]*\])?\s*\{([^{}]+)\}", source):
            for name in match.group(1).split(","):
                bibliography.append(local_file(name, main.parent, project, ".bib"))
        log = project / "_web_import_pandoc_log.json"
        command = ["pandoc", str(expanded), "--from=latex+latex_macros", "--to=json", "--sandbox", "--log=" + str(log)]
        if bibliography:
            command.append("--citeproc")
            for bib in dict.fromkeys(bibliography):
                command.extend(["--bibliography", str(bib)])
        document = json.loads(run(command, project, warnings))
        if log.is_file():
            for entry in json.loads(log.read_text(encoding="utf-8")):
                if entry.get("type") == "SkippedContent":
                    skipped = entry.get("contents", "")
                    if not re.fullmatch(r"\\(?:maketitle|bibliographystyle\s*\{[^{}]*\}|thispagestyle\s*\{[^{}]*\}|pagestyle\s*\{[^{}]*\})", skipped):
                        warnings.append("LaTeX not rendered in the article: " + skipped)
        document = transform_ast(document, environments, labels, project, main, article, warnings, graphic_dirs)
        ast = project / "_web_import_ast.json"
        ast.write_text(json.dumps(document), encoding="utf-8")
        body = run(["pandoc", str(ast), "--from=json", "--to=html5", "--mathjax", "--section-divs", "--shift-heading-level-by=1", "--wrap=none", "--sandbox"], project, warnings)
        if not body.strip():
            raise ImportFailure("Conversion produced no readable content.")
    warnings = list(dict.fromkeys(warnings))
    title = html.escape(note["title"])
    notice = ""
    if warnings:
        items = "".join("<li>" + html.escape(w) + "</li>" for w in warnings)
        notice = '<details class="conversion-notice"><summary>Conversion notes — review these items</summary><ul>' + items + '</ul></details>'
    prefix = note.get("_asset_prefix", "../../../")
    overview = prefix + ("import.html" if note["id"] == "latex-import-example" else "?note=" + quote(note["id"]))
    page = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} · Lecture notes</title><meta name="description" content="{html.escape(note.get('description', ''), quote=True)}">
<style>{ARTICLE_CSS}</style>
<script src="{prefix}assets/mathjax-config.js"></script>
<script defer src="{prefix}assets/vendor/mathjax/tex-svg.js" onerror="document.getElementById('math-status').textContent='Formula rendering could not load. Reload this page to try again.'"></script>
</head><body><header><a href="{prefix}">Research homepage</a><a href="{overview}">Topic overview</a><a href="{prefix}import.html">Upload LaTeX notes</a></header>
<main><h1>{title}</h1><p id="math-status" role="status">Loading formula rendering…</p>{notice}<article>{body}</article></main>
<footer>Converted from the author’s LaTeX source. Web layout and numbering can differ from the typeset PDF.</footer></body></html>'''
    (article / "index.html").write_text(page, encoding="utf-8")
    report = {"topic": note["id"], "archive": archive.name, "main": main.relative_to(project).as_posix(), "warnings": warnings}
    (article / "conversion-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def build(root: Path, output: Path) -> list[dict]:
    root, output = root.resolve(), output.resolve()
    if output == root or inside(root, output):
        raise ImportFailure("Build output cannot replace the source directory or one of its parents.")
    if not (root / "node_modules/mathjax/es5/tex-svg.js").is_file():
        raise ImportFailure("MathJax is missing. Run npm ci --ignore-scripts before building.")
    if not shutil.which("pandoc"):
        raise ImportFailure("Pandoc is missing. Install pandoc and poppler-utils.")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".site-build-", dir=output.parent))
    try:
        for name in ("index.html", "edit.html", "import.html", ".nojekyll"):
            source = root / name
            if source.is_file():
                shutil.copy2(source, temporary / name)
        for name in ("assets", "content", "notes"):
            shutil.copytree(root / name, temporary / name, dirs_exist_ok=True)
        vendor = temporary / "assets/vendor/mathjax"
        if vendor.exists():
            shutil.rmtree(vendor)
        shutil.copytree(root / "node_modules/mathjax/es5", vendor)
        shutil.copy2(root / "node_modules/mathjax/LICENSE", vendor / "LICENSE")
        notes = json.loads((temporary / "content/notes.json").read_text(encoding="utf-8"))
        by_id = {n["id"]: n for n in notes}
        reports = []
        sources = root / "sources"
        if sources.exists():
            for archive in sorted(p for p in sources.rglob("*") if p.is_file() and p.suffix.lower() == ".zip"):
                relative = archive.relative_to(sources)
                if len(relative.parts) != 2 or relative.parts[0] not in by_id or not SAFE_ID.fullmatch(relative.parts[0]):
                    raise ImportFailure(f"Place {relative} inside sources/<existing-topic-id>/, for example sources/optimal-transport/notes.zip.")
            for topic in sorted(by_id):
                archives = sorted(p for p in (sources / topic).glob("*") if p.is_file() and p.suffix.lower() == ".zip")
                if len(archives) > 1:
                    raise ImportFailure(f"Keep one ZIP in sources/{topic}/; remove the older ZIP before uploading a new name.")
                if not archives:
                    continue
                note = by_id[topic]
                article = temporary / "notes/imported" / topic
                try:
                    reports.append(convert_project(archives[0], note, article))
                except ImportFailure as error:
                    raise ImportFailure(f"{topic}: {error}") from error
                note["webUrl"] = f"notes/imported/{topic}/index.html"
                note["status"] = "available"
                note["updatedAt"] = datetime.now(timezone.utc).date().isoformat()
        (temporary / "content/notes.json").write_text(json.dumps(notes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        fixture = root / "tests/fixtures/latex-project"
        if fixture.is_dir():
            demo = temporary / "examples/latex-import"
            demo.mkdir(parents=True, exist_ok=True)
            sample = demo / "sample.zip"
            with zipfile.ZipFile(sample, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for file in sorted(fixture.rglob("*")):
                    if file.is_file():
                        archive.write(file, file.relative_to(fixture).as_posix())
            convert_project(sample, {"id": "latex-import-example", "title": "LaTeX import example", "description": "A demonstration of converted LaTeX text and mathematics; not a research manuscript.", "_asset_prefix": "../../"}, demo)
        (temporary / "import-report.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if output.exists():
            shutil.rmtree(output)
        temporary.rename(output)
        return reports
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    try:
        reports = build(ROOT, args.output)
    except (ImportFailure, ValueError, OSError) as error:
        print(f"LaTeX import failed: {error}", file=__import__("sys").stderr)
        return 1
    print(f"Built website with {len(reports)} imported LaTeX note(s): {args.output}")
    for report in reports:
        print(f"{report['topic']}: {len(report['warnings'])} conversion note(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
