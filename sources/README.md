# Import LaTeX lecture notes

Bookmark the [owner upload page](https://hestious.github.io/import.html). Enter your **Publishing token** and click **Connect publishing**. Choose a **Lecture-note topic** and **LaTeX project ZIP**, then click **Publish to homepage**. You do not need to visit GitHub's file-upload screen for normal updates. The page follows conversion and publication and confirms when the generated article matches your uploaded ZIP. Use **Check for updates** to check publication again.

For the initial connection, create a fine-grained GitHub personal access token scoped to **Hestious/Hestious.github.io**, with **Contents: Read and write**. Enter it only in the owner page's connection field, not in chat or a repository file. The token stays in that open page's memory and is cleared on reload or disconnect. See the [complete owner connection steps](../README.md#connect-the-owner-page).

Editing controls are hidden from ordinary public browsing. The owner page and repository remain publicly readable; GitHub's token permissions determine who can publish.

For a small demonstration, read the [converted example](https://hestious.github.io/examples/latex-import/index.html) and download the [sample LaTeX ZIP](https://hestious.github.io/examples/latex-import/sample.zip).

## Folder structure

Put **one ZIP per topic** in its matching folder, for example:

- `sources/optimal-transport/my-notes.zip`
- `sources/von-neumann-algebra/my-notes.zip`
- `sources/temporal-entanglement/my-notes.zip`

Use the owner page to upload and replace the active source ZIP. When managing files directly in GitHub, keep one filename ending in `.zip` per topic; remove the previous ZIP if you change its filename. Do not remove the folder's README.

## Preparing an Overleaf project

1. Download the project's **source ZIP** from Overleaf.
2. Include all `.tex` files, bibliography files, and figures referenced by the document.
3. Prefer `main.tex` or `root.tex` as the main document filename. A unique file containing `\documentclass` can also be detected. If your archive contains several independent documents, keep only the intended one or give it the single preferred main filename.
4. Keep relative paths unchanged, including the paths used by `\input`, `\include`, and figure commands.
5. Select the topic on the owner upload page, choose this ZIP, and publish.

The imported article is generated during the build. Update the source ZIP to change its contents; editing `notes/<topic-id>.md` does not change the imported web article. Remove the ZIP and commit to return to a Markdown-only note. You do not need to paste HTML, update `webUrl`, or change the topic's status manually. Once published, the topic has a link to its web note. An existing PDF remains available as well.

## Text and formulas

The converter reads supported LaTeX structure and mathematics with Pandoc. The website uses MathJax to render formulas. It produces a web reading layout, not an exact reproduction of the compiled PDF.

Standard text, headings, lists, formulas, and supported theorem environments become a web reading layout. Section and appendix numbering for equations and theorems is retained for the supported structures. Keep included files inside the archive at their original relative paths; literal `\graphicspath` directories are supported.

Raster figures are supported. A PDF figure is converted from its first page to an image, with a conversion warning. Supported TikZ and TikZ-CD diagrams are compiled into cropped figures for the web article. They use the converter's installed packages and supported definitions; arbitrary uploaded classes or packages are not compiled. A diagram that cannot be converted stops the build with an error instead of silently disappearing.

Include the bibliography files with the project. If a cited entry is missing from the declared bibliography but exists in another `.bib` file in the same ZIP, the converter can recover it and records that recovery in the conversion report.

Package-dependent commands, unusual custom environments, and complex page layouts may still need adjustment. Review the result and keep a PDF alongside it when exact typography matters. Conversion warnings appear in the build report and, where appropriate, on the generated article.

The last successfully published [conversion report](https://hestious.github.io/import-report.json) is available on the website. Detailed failures appear in the GitHub Actions build logs.

## Build failures

Check [GitHub Actions](https://github.com/Hestious/Hestious.github.io/actions) after uploading. Open the latest workflow run to see conversion errors. A failed build does not replace the last successful published website. Correct the source ZIP and publish the replacement from the owner page to try again.

The import limits are 25 MB per ZIP, 100 MB after expansion, 30 MB per extracted file, and 1,500 archive entries.

The converter rejects unsafe or malformed archives and ambiguous imports. A topic folder with multiple ZIPs must be reduced to one before it can be built.

## Public source files

This is a public repository. Uploaded ZIPs, their source text, and their Git history are public. Keep private drafts and unrelated files outside the ZIP.
