# Research homepage

Personal academic homepage for [Hestious](https://github.com/Hestious). The public homepage is **https://hestious.github.io/**. GitHub Actions builds the site and publishes it to GitHub Pages after commits to `main`.

## Edit the content

Bookmark the [owner upload page](https://hestious.github.io/import.html). It lets you connect your GitHub account, publish a LaTeX ZIP, delete a topic’s PDF attachment, and change your profile photo directly from the website. Editing controls are hidden during ordinary public browsing. For profile, publication, and Markdown edits, use the [editing guide](https://hestious.github.io/edit.html) or edit these files in GitHub and commit to `main`:

| Content | File |
| --- | --- |
| Name, affiliation, biography, email, profile links, profile photo | `content/profile.json` |
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

### Delete a PDF from the website

1. Connect publishing on the [owner page](https://hestious.github.io/import.html), then choose the lecture-note topic.
2. Under **PDF attachment**, review **Open current PDF**, then select **Delete PDF**.
3. Check the displayed topic and filename, and select **Confirm PDF deletion**. The file and its attachment link are removed together. Other notes in the topic remain available; a topic with no remaining content returns to **In preparation**.
4. Wait for publication confirmation. The page verifies the deployed change and that the old PDF no longer exists on the public website.

A PDF shared by another note or publication cannot be deleted here until its other references are resolved. Removing a PDF from the current homepage does not erase its earlier copies from Git history. Uploading a new PDF still uses the PDF folder workflow above.

### Change your profile photo

1. Connect publishing on the [owner page](https://hestious.github.io/import.html).
2. In **Profile photo**, choose a JPG, PNG, or WebP file no larger than 5 MB. Review the preview and enter a short **Photo description** for screen readers.
3. Select **Publish photo** and wait for publication confirmation. The homepage displays a square crop from the center of the photo.

The browser prepares a copy for web display, strips embedded photo metadata, and limits its longest side to 2,048 pixels. It uploads the prepared image and updates `photoUrl` and `photoAlt` in `content/profile.json` together, preserving the rest of your profile. Each prepared image has its own content-based filename, so visitors receive the new version without an old image remaining in their browser cache.

To restore the original geometric illustration, select **Remove photo** and then **Confirm photo removal**. Earlier photos remain in Git history. Changes to your GitHub avatar do not change your homepage photo.

### Publish a LaTeX ZIP from the website

1. Open your bookmarked [owner upload page](https://hestious.github.io/import.html) and connect GitHub using the setup below.
2. Select a **Lecture-note topic**, then choose the project's source ZIP using **LaTeX project ZIP**.
3. Click **Publish to homepage**. The page uploads the source, starts conversion, and follows deployment until that ZIP's generated article is published. Use **Check for updates** to check publication again.

Normal ZIP updates do not require opening GitHub's file-upload screen. Use the same owner page to choose and publish a replacement. The upload status distinguishes a saved source from a published web article; keep the page open to follow progress. If you reload it, reconnect before making another upload.

#### Connect the owner page

Create a fine-grained personal access token once in GitHub:

1. Sign in to GitHub as **Hestious**. Open **Settings → Developer settings → Personal access tokens → Fine-grained tokens** and create a token.
2. Choose **Hestious** as the resource owner. Under **Repository access**, choose **Only select repositories** and select **Hestious.github.io**.
3. Under **Repository permissions**, set **Contents** to **Read and write**. GitHub also includes its required metadata permission; no broader repository permissions are needed for uploads.
4. Generate the token, then enter it in **Publishing token** on the owner upload page and click **Connect publishing**. Do not send it in chat or commit it to the repository.

The page keeps the token only in memory while it is open. Reloading or disconnecting clears it. Reuse the still-valid token to reconnect, or create a replacement in GitHub if it has expired. The owner interface can remember that its controls should be shown in the current tab, but that interface preference does not grant upload access: GitHub checks the token's repository permissions on every write.

The upload page and its source code are publicly readable, just like the repository. Hiding editing controls improves the visitor view; it does not make those pages or source files private.

Try the [converted example](https://hestious.github.io/examples/latex-import/index.html) or download its [sample ZIP](https://hestious.github.io/examples/latex-import/sample.zip). This is demonstration content, not a user manuscript.

The converter detects the main document, reads supported text and mathematics, and produces a browser-readable article. Equations are typeset using MathJax. Files included with `\input` or `\include` must be inside the ZIP at their original relative paths. Include the bibliography and figures used by the document.

Each topic has one active source ZIP. The owner upload page handles normal updates. If managing files directly in GitHub, keep exactly one ZIP in each topic folder and replace the existing ZIP instead of leaving multiple versions there. The source files are stored in `sources/<topic-id>/`; generated articles are build output under `notes/imported/<topic-id>/index.html`. The build adds each article's `webUrl` and availability to the published content automatically. Do not hand-edit generated articles: update the source ZIP instead. While a topic has an imported ZIP, its web article comes from that ZIP; editing `notes/<topic-id>.md` does not change the imported article. Remove the ZIP and commit to return that topic to its Markdown-only version.

Ordinary LaTeX text, supported formulas, section and appendix numbering, and supported TikZ/TikZ-CD diagrams are converted for web reading. This is not a full TeX typesetting engine: special packages, complex custom commands, and unusual page layouts may need adjustment. A diagram conversion error stops the build rather than dropping the figure silently. Review the converted article and keep a PDF alongside it when exact typesetting is important. See [the source import guide](sources/README.md) for details.

All files in this public repository are public, including their Git history. This GitHub Pages version does not provide private draft storage or the previous server-based editor. Keep private drafts elsewhere.

## Publishing with GitHub Actions

In this repository, open **Settings → Pages**. Under **Build and deployment**, choose **GitHub Actions**. The repository's publishing workflow builds the static website, converts the LaTeX ZIPs, and deploys its output to GitHub Pages. Existing JSON/Markdown edits and PDF uploads still work.

Check the [Actions tab](https://github.com/Hestious/Hestious.github.io/actions) for the most recent build. The last published [conversion report](https://hestious.github.io/import-report.json) lists the conversion results for that deployment. A successful deployment makes the new content public. If a ZIP cannot be converted, the build fails and the last successful deployment remains live. Fix or replace the ZIP and commit again; the build log identifies the topic and error.

The website has no server or database, and visitors do not need GitHub or ChatGPT accounts. GitHub authentication controls who may upload or edit the repository.

## Local preview

For a source-only preview, run `python3 -m http.server 8000` in the repository and open `http://localhost:8000`. To preview generated LaTeX articles and locally bundled MathJax, install Python 3, Node.js 22 with npm, Pandoc, Poppler's `pdftoppm`, and the TeX packages used to render supported TikZ figures.

On Ubuntu or Debian, install the conversion tools with:

```sh
sudo apt-get update
sudo apt-get install --yes pandoc poppler-utils texlive-latex-base texlive-pictures
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
- `import.html`, `assets/import.js`: owner connection, direct LaTeX ZIP uploads, and publication progress.
- `sources/`: LaTeX project ZIPs organized by topic.
- `scripts/build_site.py`: static build and LaTeX conversion.
- `.github/workflows/`: automated build and Pages publication.
- `content/`, `notes/`, `assets/pdfs/`: editable academic content.
- `.nojekyll`: tells GitHub Pages to serve this static site directly.

No personal publication claims were invented. The initial empty profile fields and publication list are ready for the owner to fill in.
