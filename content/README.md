# Website content

Edit the JSON files in this folder with GitHub's pencil button, then commit to `main`. GitHub Actions rebuilds and publishes the website after the commit.

- `profile.json`: your name, affiliation, biography, contact email, and links.
- `interests.json`: research-interest sections.
- `publications.json`: publication list; see the [repository README](../README.md) for a template.
- `notes.json`: topic titles, descriptions, categories, PDF links, Markdown manuscript paths, and availability.

For a simple manuscript, edit `notes/<topic-id>.md`. PDF attachments go in `assets/pdfs/` and are linked by the topic's `pdfUrl`.

For an existing LaTeX manuscript, use [Import LaTeX ZIP](https://hestious.github.io/import.html). Put one source ZIP in `sources/<topic-id>/`. The build converts it into a web article with rendered equations and automatically sets `webUrl` and availability in the **published** `content/notes.json`. These generated fields do not have to be added to the source JSON by hand.

The imported web article comes from the ZIP. Editing a topic's Markdown file does not change that article. Replace the ZIP to update it, or remove the ZIP and commit to return to the Markdown-only version. An attached PDF can remain alongside either format.

[LaTeX import guide](../sources/README.md) · [Editing guide](../README.md)
