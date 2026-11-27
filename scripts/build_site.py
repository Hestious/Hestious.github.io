#!/usr/bin/env python3
"""Build a static research site, converting owner-uploaded LaTeX ZIP projects.

Text and math are parsed by sandboxed Pandoc after bounded local include
expansion. TikZ diagrams use a separate, resource-limited TeX process with shell
escape disabled and restrictive file access. A failed import leaves the last
build intact.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import html
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tempfile
import resource
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
                prefix = line[:pos]
                # A comment-only line is not a blank TeX paragraph. Keeping a
                # newline here breaks matrices/tikz-cd cells into paragraphs.
                line = prefix + ("\n" if prefix.strip() and line.endswith("\n") else "")
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


def section_sequence(source: str) -> list[tuple[int, str]]:
    result, counter, appendix = [], 0, False
    body_start = source.find(r"\begin{document}")
    for match in re.finditer(r"\\appendix\b|\\section(\*)?(?:\[[^\]]*\])?\s*\{", source):
        if match.start() < body_start:
            continue
        if match.group(0).startswith(r"\appendix"):
            appendix, counter = True, 0
        elif not match.group(1):
            counter += 1
            label = chr(64 + counter) if appendix and counter <= 26 else str(counter)
            result.append((match.start(), label))
        else:
            result.append((match.start(), ""))
    return result


def numbered_math(body: str, environment: str, prefix: str, counters: dict) -> str:
    if environment.endswith("*"):
        return body
    # Split only the outer alignment rows, not matrices or aligned/split groups.
    boundaries, nested, depth = [], [], 0
    for match in re.finditer(r"\\begin\{([^{}]+)\}|\\end\{([^{}]+)\}|\\\\(?:\[[^\]]*\])?|(?<!\\)[{}]", body):
        token = match.group(0)
        if match.group(1): nested.append(match.group(1))
        elif match.group(2):
            if nested: nested.pop()
        elif token == "{": depth += 1
        elif token == "}": depth = max(0, depth - 1)
        elif token.startswith("\\\\") and not nested and depth == 0:
            boundaries.append((match.start(), match.end()))
    if environment not in ("align", "alignat", "gather", "eqnarray"):
        boundaries = []
    result, cursor = [], 0
    for end, next_start in boundaries + [(len(body), len(body))]:
        row = body[cursor:end]
        if row.strip() and not re.search(r"\\(?:nonumber|notag|tag)\b", row):
            counters[prefix] = counters.get(prefix, 0) + 1
            row += r"\tag{" + prefix + "." + str(counters[prefix]) + "}"
        result.append(row + body[end:next_start])
        cursor = next_start
    return "".join(result)


def protect_displays(source: str) -> tuple[str, dict[str, str], set[str]]:
    """Keep source equation/align numbering instead of Pandoc's lossy aligned form."""
    environments, labels = {}, set()
    cursor, pieces = 0, []
    by_section = bool(re.search(r"\\(?:numberwithin|counterwithin)\s*\{equation\}\s*\{section\}", source))
    sections, counters = section_sequence(source), {}
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
        if by_section:
            prefix = "0"
            for position, number in sections:
                if position > match.start(): break
                if number: prefix = number
            body = numbered_math(body, environment, prefix, counters)
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


def apply_document_numbering(document: dict, source: str) -> None:
    sections = [number for _, number in section_sequence(source)]
    definitions = {}
    for match in re.finditer(r"\\newtheorem\s*\{([^{}]+)\}(?:\[([^\]]+)\])?\s*\{([^{}]+)\}(?:\[([^\]]+)\])?", source):
        definitions[match.group(1)] = {"counter": match.group(2) or match.group(1), "within": match.group(4), "title": match.group(3)}
    state = {"section": "0", "section_index": 0, "counters": {}, "references": {}}

    def walk(value):
        if isinstance(value, list):
            for item in value: walk(item)
        elif isinstance(value, dict):
            kind, content = value.get("t"), value.get("c")
            if kind == "Header" and content[0] == 1:
                index = state["section_index"]
                state["section_index"] += 1
                if index < len(sections) and sections[index]:
                    state["section"] = sections[index]
                    state["references"][content[1][0]] = sections[index]
                    content[2][:0] = [{"t": "Str", "c": sections[index] + "."}, {"t": "Space"}]
            if kind == "Div":
                attrs, blocks = content
                environment = next((name for name in attrs[1] if name in definitions), None)
                if environment:
                    definition = definitions[environment]
                    counter = definition["counter"]
                    within = definition["within"] or definitions.get(counter, {}).get("within")
                    prefix = state["section"] if within == "section" else ""
                    key = (counter, prefix)
                    state["counters"][key] = state["counters"].get(key, 0) + 1
                    number = (prefix + "." if prefix else "") + str(state["counters"][key])
                    if attrs[0]: state["references"][attrs[0]] = number
                    if blocks and blocks[0].get("t") in ("Para", "Plain"):
                        first = blocks[0]["c"]
                        if first and first[0].get("t") == "Strong":
                            first[0]["c"] = [{"t": "Str", "c": definition["title"]}, {"t": "Space"}, {"t": "Str", "c": number}]
            for child in value.values(): walk(child)
    walk(document["blocks"])

    def references(value):
        if isinstance(value, list):
            for item in value: references(item)
        elif isinstance(value, dict):
            if value.get("t") == "Link":
                attrs, inlines, target = value["c"]
                label = dict(attrs[2]).get("reference")
                if label in state["references"]:
                    value["c"][1] = [{"t": "Str", "c": state["references"][label]}]
            for child in value.values(): references(child)
    references(document["blocks"])


def braced(source: str, start: int) -> tuple[str, int]:
    while start < len(source) and source[start].isspace(): start += 1
    if start >= len(source) or source[start] != "{":
        raise ImportFailure("Expected a literal brace-delimited LaTeX argument.")
    depth, cursor = 1, start + 1
    while cursor < len(source):
        if source[cursor] == "\\":
            cursor += 2
            continue
        if source[cursor] == "{": depth += 1
        if source[cursor] == "}":
            depth -= 1
            if not depth: return source[start + 1:cursor], cursor + 1
        cursor += 1
    raise ImportFailure("Unclosed brace-delimited LaTeX argument.")


def diagram_preamble(source: str) -> str:
    preamble = source.split(r"\begin{document}", 1)[0]
    definitions = []
    pattern = r"\\(newcommand|renewcommand|providecommand|DeclareMathOperator|definecolor|tikzset|usetikzlibrary)\*?"
    for match in re.finditer(pattern, preamble):
        name, cursor = match.group(1), match.end()
        try:
            if name in ("newcommand", "renewcommand", "providecommand", "DeclareMathOperator"):
                while cursor < len(preamble) and preamble[cursor].isspace(): cursor += 1
                if preamble[cursor] == "{": _, cursor = braced(preamble, cursor)
                else:
                    control = re.match(r"\\[A-Za-z@]+", preamble[cursor:])
                    if not control: continue
                    cursor += control.end()
                for _ in range(2):
                    optional = re.match(r"\s*\[[^\]]*\]", preamble[cursor:])
                    if optional: cursor += optional.end()
                _, cursor = braced(preamble, cursor)
            else:
                for _ in range(3 if name == "definecolor" else 1): _, cursor = braced(preamble, cursor)
            definitions.append(preamble[match.start():cursor])
        except ImportFailure:
            raise ImportFailure(f"Cannot parse diagram preamble command \\{name}.")
    return "\n".join(definitions)


def restricted_command(command: list[str], directory: Path) -> None:
    def limits():
        resource.setrlimit(resource.RLIMIT_CPU, (25, 25))
        resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024, 768 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024 * 1024, 32 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    environment = {"PATH": os.defpath, "HOME": str(directory), "TMPDIR": str(directory),
                   "openin_any": "p", "openout_any": "p", "shell_escape": "f",
                   "MKTEXPK": "0", "MKTEXTFM": "0", "MKTEXMF": "0", "MKTEXFMT": "0"}
    try:
        log_path = directory / "converter-output.log"
        with log_path.open("wb") as output:
            result = subprocess.run(command, cwd=directory, env=environment,
                                    stdout=output, stderr=subprocess.STDOUT, timeout=35, preexec_fn=limits)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ImportFailure(f"Diagram conversion failed or exceeded its resource limit: {error}") from error
    if result.returncode:
        with log_path.open("rb") as output:
            output.seek(max(0, log_path.stat().st_size - 12000))
            lines = output.read(12000).decode("utf-8", errors="replace").splitlines()
        relevant = [line for line in lines if line.startswith("!") or "Error" in line or "not found" in line or re.search(r"\.tex:\d+:", line)]
        raise ImportFailure("Diagram conversion failed: " + " ".join(relevant[-4:] or lines[-5:]))


def render_diagrams(source: str, article: Path) -> tuple[str, dict[str, str]]:
    matches = list(re.finditer(r"\\begin\{(tikzpicture|tikzcd)\}", source))
    if not matches: return source, {}
    if len(matches) > 30: raise ImportFailure("A note can contain at most 30 TikZ diagrams.")
    compiler, renderer = shutil.which("pdflatex"), shutil.which("pdftoppm")
    if not compiler or not renderer:
        raise ImportFailure("TikZ rendering requires texlive-latex-base, texlive-pictures, and poppler-utils.")
    preamble = diagram_preamble(source)
    replacements, diagrams = [], {}
    for index, match in enumerate(matches, 1):
        closing = r"\end{" + match.group(1) + "}"
        stop = source.find(closing, match.end())
        if stop < 0: raise ImportFailure("Unclosed TikZ diagram.")
        end = stop + len(closing)
        diagram = source[match.start():end]
        if len(diagram.encode()) > 200000: raise ImportFailure("A TikZ diagram exceeds 200 KB.")
        start = match.start()
        scale = re.search(r"\\scalebox\s*\{[^{}]*\}\s*\{\s*$", source[:start])
        if scale:
            outer = source.find("{", source.find("}", scale.start()) + 1)
            _, outer_end = braced(source, outer)
            if source[end:outer_end - 1].strip() == "": start, end = scale.start(), outer_end
        left, right = source[:start], source[end:]
        opening = re.search(r"\\\[\s*$", left)
        closing_math = re.match(r"\s*\\\]", right)
        if opening and closing_math: start, end = opening.start(), end + closing_math.end()
        marker = f"WEBLATEXDIAGRAM{index:05d}"
        image = f"media/diagram-{index:03d}.png"
        (article / "media").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="latex-diagram-") as temporary:
            directory = Path(temporary)
            tex = (r"\documentclass{article}" + "\n" + r"\usepackage{amsmath,amssymb,tikz,tikz-cd}" + "\n" + preamble + "\n"
                   + r"\pagestyle{empty}\begin{document}\newbox\diagramBox\setbox\diagramBox=\hbox{" + ("$" if match.group(1) == "tikzcd" else "") + diagram + ("$" if match.group(1) == "tikzcd" else "") + "}\n"
                   + r"\setbox\diagramBox=\vbox{\kern2pt\hbox{\kern2pt\box\diagramBox\kern2pt}\kern2pt}"
                   + r"\pdfpagewidth=\wd\diagramBox\pdfpageheight=\dimexpr\ht\diagramBox+\dp\diagramBox\relax"
                   + r"\pdfhorigin=0pt\pdfvorigin=0pt\shipout\hbox{\raise\dp\diagramBox\box\diagramBox}\end{document}")
            (directory / "diagram.tex").write_text(tex)
            restricted_command([compiler, "-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "diagram.tex"], directory)
            restricted_command([renderer, "-f", "1", "-singlefile", "-scale-to", "2200", "-png", "diagram.pdf", "diagram"], directory)
            shutil.copyfile(directory / "diagram.png", article / image)
        diagrams[marker] = image
        replacements.append((start, end, "\n\n" + marker + "\n\n"))
    for start, end, replacement in reversed(replacements): source = source[:start] + replacement + source[end:]
    return source, diagrams


def transform_ast(value, environments, equation_labels, project, main, article, warnings, graphic_dirs=(), diagrams=None):
    if isinstance(value, list):
        return [transform_ast(x, environments, equation_labels, project, main, article, warnings, graphic_dirs, diagrams) for x in value]
    if not isinstance(value, dict):
        return value
    kind, content = value.get("t"), value.get("c")
    if kind == "Str" and content in (diagrams or {}):
        return {"t": "Image", "c": [["", ["latex-diagram"], []], [{"t": "Str", "c": "Diagram from the LaTeX source"}], [diagrams[content], ""]]}
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
    return {key: transform_ast(item, environments, equation_labels, project, main, article, warnings, graphic_dirs, diagrams)
            for key, item in value.items()}


ARTICLE_CSS = """
:root{color-scheme:light;font-family:Georgia,'Times New Roman',serif;color:#21353b;background:#fbfdfc}*{box-sizing:border-box}body{margin:0;font-size:18px;line-height:1.75}header,main,footer{max-width:54rem;margin:auto;padding:1.5rem 1.4rem}header{font-family:system-ui,sans-serif;border-bottom:1px solid #dbe4e1;font-size:.9rem}header a{margin-right:1.5rem}a{color:#246961;text-underline-offset:3px}h1,h2,h3{line-height:1.25;margin-top:2rem}h1{font-size:2.2rem}h2{font-size:1.6rem}p{overflow-wrap:anywhere}img{max-width:100%;height:auto}figure{margin:2rem 0;text-align:center}figcaption{font-size:.9rem;color:#536461}table{border-collapse:collapse;display:block;overflow:auto;max-width:100%}td,th{padding:.45rem .7rem;border-bottom:1px solid #dbe4e1}.math.display{display:block;overflow-x:auto;overflow-y:hidden;margin:1.4rem 0;padding:1rem .4rem}mjx-container{max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:1rem;background:#edf2f0;border-radius:.4rem;font-size:.85rem}code{font-size:.88em}.theorem,.lemma,.proposition,.definition,.corollary{border-left:3px solid #5b8a80;padding:.2rem 1rem;margin:1.5rem 0}.proof{padding:.2rem 1rem}.conversion-notice{background:#f1f5f3;border:1px solid #d4e1db;padding:1rem;margin:1.5rem 0;font: .88rem/1.6 system-ui,sans-serif}.conversion-notice summary{cursor:pointer;font-weight:600}#math-status{font:.85rem/1.5 system-ui,sans-serif;color:#647770}footer{font: .85rem/1.6 system-ui,sans-serif;border-top:1px solid #dbe4e1;margin-top:3rem}#TOC{font: .95rem/1.6 system-ui,sans-serif;padding:1rem;background:#f1f5f3}.unconverted-latex{color:#6d3f24}@media(max-width:600px){body{font-size:17px}h1{font-size:1.8rem}header,main,footer{padding:1.2rem}}
"""


def supplement_bibliography(source: str, bibliography: list[Path], project: Path, warnings: list[str]) -> None:
    key_pattern = re.compile(r"@[A-Za-z]+\s*\{\s*([^,\s]+)\s*,")
    available = set()
    for path in bibliography: available.update(key_pattern.findall(read_tex(path)))
    cited = set()
    for match in re.finditer(r"\\cite[A-Za-z]*\*?(?:\[[^\]]*\]){0,2}\s*\{([^{}]+)\}", source):
        cited.update(key.strip() for key in match.group(1).split(","))
    missing = cited - available
    recovered = []
    for path in sorted(project.rglob("*.bib")):
        if path in bibliography or "__MACOSX" in path.parts: continue
        text = read_tex(path)
        for match in key_pattern.finditer(text):
            key = match.group(1)
            if key not in missing: continue
            _, end = braced(text, text.find("{", match.start()))
            recovered.append(text[match.start():end])
            missing.remove(key)
            warnings.append(f"Recovered cited reference {key} from {path.name}, which was included in the ZIP but not named in the bibliography command.")
    if recovered:
        destination = project / "_web_recovered.bib"
        destination.write_text("\n\n".join(recovered))
        bibliography.append(destination)


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
        source, diagrams = render_diagrams(source, article)
        numbering_source = source
        source, environments, labels = protect_displays(source)
        expanded = project / "_web_import_expanded.tex"
        expanded.write_text(source, encoding="utf-8")
        bibliography = []
        for match in re.finditer(r"\\(?:bibliography|addbibresource)(?:\[[^\]]*\])?\s*\{([^{}]+)\}", source):
            for name in match.group(1).split(","):
                bibliography.append(local_file(name, main.parent, project, ".bib"))
        supplement_bibliography(source, bibliography, project, warnings)
        log = project / "_web_import_pandoc_log.json"
        command = ["pandoc", str(expanded), "--from=latex+latex_macros", "--to=json", "--sandbox", "--log=" + str(log)]
        if bibliography:
            command.append("--citeproc")
            for bib in dict.fromkeys(bibliography):
                command.extend(["--bibliography", str(bib)])
        document = json.loads(run(command, project, warnings))
        apply_document_numbering(document, numbering_source)
        if log.is_file():
            for entry in json.loads(log.read_text(encoding="utf-8")):
                if entry.get("type") == "SkippedContent":
                    skipped = entry.get("contents", "")
                    handled = bool(re.match(r"\\(?:usetikzlibrary|definecolor|tikzset)\b", skipped) and diagrams)
                    handled = handled or bool(re.fullmatch(r"\\(?:numberwithin|counterwithin)\s*\{equation\}\s*\{section\}|\\appendix|\\setlength\s*\{\\parindent\}\s*\{[^{}]*\}", skipped))
                    if not handled and not re.fullmatch(r"\\(?:maketitle|centering|bibliographystyle\s*\{[^{}]*\}|thispagestyle\s*\{[^{}]*\}|pagestyle\s*\{[^{}]*\})", skipped):
                        warnings.append("LaTeX not rendered in the article: " + skipped)
        # Metadata can contain citeproc bookkeeping such as \\nocite{*}; the
        # fragment writer does not display it. Only transform the visible body.
        document["blocks"] = transform_ast(document["blocks"], environments, labels, project, main, article, warnings, graphic_dirs, diagrams)
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
    overview = prefix + ("#notes" if note["id"] == "latex-import-example" else "?note=" + quote(note["id"]))
    page = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} · Lecture notes</title><meta name="description" content="{html.escape(note.get('description', ''), quote=True)}">
<style>{ARTICLE_CSS}</style>
<script src="{prefix}assets/mathjax-config.js"></script>
<script defer src="{prefix}assets/owner-ui.js"></script>
<script defer src="{prefix}assets/vendor/mathjax/tex-svg.js" onerror="document.getElementById('math-status').textContent='Formula rendering could not load. Reload this page to try again.'"></script>
</head><body><header><a href="{prefix}">Research homepage</a><a href="{overview}">Topic overview</a><a data-owner-only hidden href="{prefix}import.html?topic={quote(note['id'])}">Replace LaTeX ZIP</a></header>
<main><h1>{title}</h1><p id="math-status" role="status">Loading formula rendering…</p>{notice}<article>{body}</article></main>
<footer>Converted from the author’s LaTeX source. Web layout and numbering can differ from the typeset PDF.</footer></body></html>'''
    (article / "index.html").write_text(page, encoding="utf-8")
    report = {"topic": note["id"], "archive": archive.name, "sourceSha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "main": main.relative_to(project).as_posix(), "diagramCount": len(diagrams), "warnings": warnings}
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
                note["sourceSha256"] = reports[-1]["sourceSha256"]
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
