# Import LaTeX lecture notes

Use [Import LaTeX ZIP](https://hestious.github.io/import.html) to choose a topic and open its GitHub upload page. Upload a source ZIP and click **Commit changes**. GitHub Actions converts the project and republishes the site automatically.

For a small demonstration, read the [converted example](https://hestious.github.io/examples/latex-import/index.html) and download the [sample LaTeX ZIP](https://hestious.github.io/examples/latex-import/sample.zip).

## Folder structure

Put **one ZIP per topic** in its matching folder, for example:

- `sources/optimal-transport/my-notes.zip`
- `sources/von-neumann-algebra/my-notes.zip`
- `sources/temporal-entanglement/my-notes.zip`

The filename can be anything ending in `.zip`. When updating, keep the same filename to replace the existing ZIP. If changing the filename, also remove the previous ZIP so only one remains. Do not remove the folder's README.

## Preparing an Overleaf project

1. Download the project's **source ZIP** from Overleaf.
2. Include all `.tex` files, bibliography files, and figures referenced by the document.
3. Prefer `main.tex` or `root.tex` as the main document filename. A unique file containing `\documentclass` can also be detected. If your archive contains several independent documents, keep only the intended one or give it the single preferred main filename.
4. Keep relative paths unchanged, including the paths used by `\input`, `\include`, and figure commands.
5. Upload the ZIP into the selected topic folder and commit.

The imported article is generated during the build. Update the source ZIP to change its contents; editing `notes/<topic-id>.md` does not change the imported web article. Remove the ZIP and commit to return to a Markdown-only note. You do not need to paste HTML, update `webUrl`, or change the topic's status manually. Once published, the topic has a link to its web note. An existing PDF remains available as well.

## Text and formulas

The converter reads supported LaTeX structure and mathematics with Pandoc. The website uses MathJax to render formulas. It produces a web reading layout, not an exact reproduction of the compiled PDF.

Standard text, headings, lists, and mathematical formulas are the intended input. Include files must be contained in the archive. Raster figures are supported. A PDF figure is converted from its first page to an image, with a conversion warning. SVG figures and TikZ drawings are not rendered automatically; the converter shows a notice or the original command instead. Package-dependent commands, unusual custom environments, and complex page layouts may not translate completely. Review the result; keep a PDF alongside it for the original typesetting. Conversion warnings appear in the build report and, where appropriate, on the generated article.

The last successfully published [conversion report](https://hestious.github.io/import-report.json) is available on the website. Detailed failures appear in the GitHub Actions build logs.

## Build failures

Check [GitHub Actions](https://github.com/Hestious/Hestious.github.io/actions) after uploading. Open the latest workflow run to see conversion errors. A failed build does not replace the last successful published website. Correct the source ZIP and commit the replacement to try again.

The import limits are 25 MB per ZIP, 100 MB after expansion, 30 MB per extracted file, and 1,500 archive entries.

The converter rejects unsafe or malformed archives and ambiguous imports. A topic folder with multiple ZIPs must be reduced to one before it can be built.

## Public source files

This is a public repository. Uploaded ZIPs, their source text, and their Git history are public. Keep private drafts and unrelated files outside the ZIP.
