# Lecture notes

## Markdown notes

Edit a topic's Markdown file with GitHub's pencil button. Use paragraphs, `#` headings, lists, block quotes, and fenced code blocks. The homepage reads the manuscript specified by that topic's `bodyFile` in `content/notes.json`.

The initial topic files contain only an editing comment and have no manuscript content. Set `status` to `available` in `content/notes.json` when a Markdown note is ready.

## LaTeX notes with rendered formulas

Use [Import LaTeX ZIP](https://hestious.github.io/import.html) to choose a topic and upload its LaTeX project ZIP. The build creates a web article with supported text and formulas under `notes/imported/<topic-id>/index.html` and adds the reading link automatically.

Generated articles are build output. Update the ZIP in `sources/<topic-id>/` to change an imported article; editing the Markdown file here does not change that article. Remove the ZIP and commit if you want the topic to use only its Markdown manuscript again.

For the complete workflow, see the [LaTeX import guide](../sources/README.md).

## PDF attachments

A PDF can be attached alongside a Markdown note or imported LaTeX article. Upload it to `assets/pdfs/`, then set its path in `content/notes.json`, for example `assets/pdfs/optimal-transport.pdf`. Keep the PDF when the original typography or a specialized diagram matters.
