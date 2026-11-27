# Research homepage

Personal academic homepage for [Hestious](https://github.com/Hestious). The public homepage is **https://hestious.github.io/**. GitHub Actions builds the site and publishes it to GitHub Pages after commits to `main`.

## Edit the content

Open the website's **Edit website** page for direct links, or edit these files in GitHub and commit the changes to `main`:

| Content | File |
| --- | --- |
| Name, affiliation, biography, email, profile links | `content/profile.json` |
| Research interests | `content/interests.json` |
| Publications and preprints | `content/publications.json` |
| Lecture-note titles, categories, descriptions, PDF links, availability | `content/notes.json` |
| Lecture-note text | `notes/<topic-id>.md` |
| LaTeX project ZIP for a topic | `sources/<topic-id>/<project>.zip` |
| PDF files | `assets/pdfs/` |

On GitHub, click the pencil icon, edit the file, then choose **Commit changes**. GitHub Actions rebuilds and republishes updates to `main` automatically; conversion and publication may take a few minutes.

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

1. Edit the matching Markdown file in `notes/`. Supported reading-page formatting includes paragraphs, `#` headings, lists, block quotes, and fenced code blocks. To turn an existing LaTeX project into a web note with rendered formulas, use the ZIP import described below. A PDF can be attached alongside either format.
2. Upload the PDF to `assets/pdfs/` using GitHub's **Add file → Upload files** action in that folder.
3. Set the note's `pdfUrl` in `content/notes.json`, for example `assets/pdfs/optimal-transport.pdf`.
4. Set `status` to `available` when ready, and optionally set `updatedAt` to a date such as `2026-11-27`. Use `coming-soon` for a planned topic.
5. To add a new topic, add a new object to `content/notes.json` and create its Markdown file. Keep `id` unique and `bodyFile` equal to the file path.

### Import a LaTeX ZIP

1. Open [Import LaTeX ZIP](https://hestious.github.io/import.html) and select a lecture-note topic.
2. Click **Upload ZIP on GitHub**. Sign in as **Hestious**, upload the project's source ZIP, and choose **Commit changes**.
3. Check the [build status](https://github.com/Hestious/Hestious.github.io/actions). Once publishing succeeds, open the topic on the homepage and choose its web-note link.

Try the [converted example](https://hestious.github.io/examples/latex-import/index.html) or download its [sample ZIP](https://hestious.github.io/examples/latex-import/sample.zip). This is demonstration content, not a user manuscript.

The converter detects the main document, reads supported text and mathematics, and produces a browser-readable article. Equations are typeset using MathJax. Files included with `\input` or `\include` must be inside the ZIP at their original relative paths. Include the bibliography and figures used by the document.

Each topic folder accepts **one ZIP**. To update a note, upload a replacement using the same filename. If you use a different filename, remove the old ZIP as part of your update so there is only one. The source files are stored in `sources/<topic-id>/`; generated articles are build output under `notes/imported/<topic-id>/index.html`. The build adds each article's `webUrl` and availability to the published content automatically. Do not hand-edit generated articles: update the source ZIP instead. While a topic has an imported ZIP, its web article comes from that ZIP; editing `notes/<topic-id>.md` does not change the imported article. Remove the ZIP and commit to return that topic to its Markdown-only version.

Ordinary LaTeX text and supported formulas convert well, but this is not a full TeX typesetting engine. Special packages, complex custom commands, and TikZ diagrams may need adjustment. Review the converted article and keep a PDF alongside it when exact typesetting is important. See [the source import guide](sources/README.md) for details.

All files in this public repository are public, including their Git history. This GitHub Pages version does not provide private draft storage or the previous server-based editor. Keep private drafts elsewhere.

## Publishing with GitHub Actions

In this repository, open **Settings → Pages**. Under **Build and deployment**, choose **GitHub Actions**. The repository's publishing workflow builds the static website, converts the LaTeX ZIPs, and deploys its output to GitHub Pages. Existing JSON/Markdown edits and PDF uploads still work.

Check the [Actions tab](https://github.com/Hestious/Hestious.github.io/actions) for the most recent build. The last published [conversion report](https://hestious.github.io/import-report.json) lists the conversion results for that deployment. A successful deployment makes the new content public. If a ZIP cannot be converted, the build fails and the last successful deployment remains live. Fix or replace the ZIP and commit again; the build log identifies the topic and error.

The website has no server or database, and visitors do not need GitHub or ChatGPT accounts. GitHub authentication controls who may upload or edit the repository.

## Local preview

For a source-only preview, run `python3 -m http.server 8000` in the repository and open `http://localhost:8000`. To preview generated LaTeX articles and locally bundled MathJax, install Python 3, Node.js 22 with npm, Pandoc, and Poppler's `pdftoppm`.

On Ubuntu or Debian, install the conversion tools with:

```sh
sudo apt-get update
sudo apt-get install --yes pandoc poppler-utils
```

Then run these commands from the repository root:

```sh
npm ci --ignore-scripts
python3 scripts/build_site.py --output dist
python3 -m http.server 8000 --directory dist
```

`npm ci` installs the pinned MathJax dependency from the lockfile. Open `http://localhost:8000` to review the generated site. The GitHub Actions workflow runs the corresponding install and build steps automatically.

Do not open `index.html` directly as a file: browsers restrict fetching neighboring content files from `file://` pages.

## Files

- `index.html`, `assets/style.css`, `assets/site.js`: website structure, visual design, and interactions.
- `edit.html`: editing guide and direct GitHub links.
- `import.html`, `assets/import.js`: LaTeX topic picker and GitHub upload links.
- `sources/`: LaTeX project ZIPs organized by topic.
- `scripts/build_site.py`: static build and LaTeX conversion.
- `.github/workflows/`: automated build and Pages publication.
- `content/`, `notes/`, `assets/pdfs/`: editable academic content.
- `.nojekyll`: tells GitHub Pages to serve this static site directly.

No personal publication claims were invented. The initial empty profile fields and publication list are ready for the owner to fill in.
