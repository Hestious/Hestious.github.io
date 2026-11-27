# Research homepage

Personal academic homepage for [Hestious](https://github.com/Hestious). The intended GitHub Pages address is **https://hestious.github.io/**. A repository upload alone does not activate the site; Pages must also be enabled.

## Edit the content

Open the website's **Edit website** page for direct links, or edit these files in GitHub and commit the changes to `main`:

| Content | File |
| --- | --- |
| Name, affiliation, biography, email, profile links | `content/profile.json` |
| Research interests | `content/interests.json` |
| Publications and preprints | `content/publications.json` |
| Lecture-note titles, categories, descriptions, PDF links, availability | `content/notes.json` |
| Lecture-note text | `notes/<topic-id>.md` |
| PDF files | `assets/pdfs/` |

On GitHub, click the pencil icon, edit the file, then choose **Commit changes**. GitHub Pages republishes updates to the selected branch automatically; publication may take a few minutes.

The JSON files use quoted text, commas between items, and square brackets for lists. Keep the field names unchanged. Empty optional text is `""` and an empty list is `[]`.

### Add a publication

Replace the empty array in `content/publications.json` with a list of objects using this structure. The text below is a template, not an actual publication:

```json
[
  {
    "id": "paper-2026-example",
    "title": "Your paper title",
    "authors": "Your name and coauthors",
    "year": "2026",
    "venue": "Journal name or preprint",
    "abstract": "Your abstract",
    "url": "https://arxiv.org/abs/YOUR_IDENTIFIER",
    "pdfUrl": ""
  }
]
```

Add later entries after a comma, inside the same outer square brackets. Use a unique `id` for each entry. Leave `url` blank until a real publication link is ready.

### Add or update lecture notes

1. Edit the matching Markdown file in `notes/`. Supported reading-page formatting includes paragraphs, `#` headings, lists, block quotes, and fenced code blocks. For typeset equations, attach a PDF.
2. Upload the PDF to `assets/pdfs/` using GitHub's **Add file → Upload files** action in that folder.
3. Set the note's `pdfUrl` in `content/notes.json`, for example `assets/pdfs/optimal-transport.pdf`.
4. Set `status` to `available` when ready, and optionally set `updatedAt` to a date such as `2026-11-27`. Use `coming-soon` for a planned topic.
5. To add a new topic, add a new object to `content/notes.json` and create its Markdown file. Keep `id` unique and `bodyFile` equal to the file path.

All files in this public repository are public, including their Git history. This GitHub Pages version does not provide private draft storage or the previous server-based editor. Keep private drafts elsewhere.

## Enable GitHub Pages

In this repository, open **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, select **main** and **/(root)**, then Save. Keep `.nojekyll` at the root. No build command, Node dependencies, server, database, ChatGPT login, or paid hosting is required for the website.

## Local preview

Run `python3 -m http.server 8000` in the repository and open `http://localhost:8000`. Do not open `index.html` directly as a file: browsers restrict fetching neighboring content files from `file://` pages.

## Files

- `index.html`, `assets/style.css`, `assets/site.js`: website structure, visual design, and interactions.
- `edit.html`: editing guide and direct GitHub links.
- `content/`, `notes/`, `assets/pdfs/`: editable academic content.
- `.nojekyll`: tells GitHub Pages to serve this static site directly.

No personal publication claims were invented. The initial empty profile fields and publication list are ready for the owner to fill in.
