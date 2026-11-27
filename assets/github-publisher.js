const API = 'https://api.github.com';
export const REPOSITORY = 'Hestious/Hestious.github.io';
export const REPO_URL = `https://github.com/${REPOSITORY}`;
export const MAX_ZIP_BYTES = 25 * 1024 * 1024;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const PREFIX = `/repos/${REPOSITORY}`;
const TOPIC = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA = /^[a-f0-9]{40}$/;
const MANAGED_PHOTO = /^assets\/profile\/photo-[a-f0-9]{64}\.(?:png|jpg|webp)$/;
const SITE = 'https://hestious.github.io/';
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

export class PublishError extends Error {
  constructor(message, code = 'request-failed') { super(message); this.name = 'PublishError'; this.code = code; }
}

export function validateZip(bytes, name = 'source.zip') {
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new PublishError('Choose a non-empty ZIP file.', 'invalid-file');
  if (!/\.zip$/i.test(name)) throw new PublishError('Choose a LaTeX project ZIP file.', 'invalid-file');
  if (bytes.length > MAX_ZIP_BYTES) throw new PublishError('The ZIP must be 25 MB or smaller.', 'invalid-file');
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || !((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6) || (bytes[2] === 7 && bytes[3] === 8))) {
    throw new PublishError('This file does not have a ZIP file signature.', 'invalid-file');
  }
}

export function validatePhoto(bytes, filename) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new PublishError('Choose a non-empty PNG, JPEG, or WebP photograph.', 'invalid-file');
  if (bytes.length > MAX_PHOTO_BYTES) throw new PublishError('The photograph must be 5 MB or smaller.', 'invalid-file');
  const extension = String(filename || '').match(/\.(png|jpe?g|webp)$/i)?.[1].toLowerCase();
  const starts = signature => signature.every((value, index) => bytes[index] === value);
  const png = bytes.length >= 24 && starts([137, 80, 78, 71, 13, 10, 26, 10]) && String.fromCharCode(...bytes.subarray(12, 16)) === 'IHDR';
  const jpeg = bytes.length >= 4 && starts([255, 216, 255]);
  const webp = bytes.length >= 16 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(String.fromCharCode(...bytes.subarray(12, 16)));
  if (extension === 'png' && png) return { extension: 'png', mimeType: 'image/png' };
  if ((extension === 'jpg' || extension === 'jpeg') && jpeg) return { extension: 'jpg', mimeType: 'image/jpeg' };
  if (extension === 'webp' && webp) return { extension: 'webp', mimeType: 'image/webp' };
  throw new PublishError('Choose a PNG, JPEG, or WebP file whose contents match its filename. SVG files are not supported.', 'invalid-file');
}

function managedPdf(path) {
  return typeof path === 'string' && path.length <= 240 && /^assets\/pdfs\/[A-Za-z0-9][A-Za-z0-9_. ()-]*\.pdf$/i.test(path) && !path.includes('..');
}
function localReference(value) {
  if (typeof value !== 'string' || !value || /[\\\u0000-\u001f]/.test(value)) return '';
  try {
    const url = new URL(value, SITE);
    return url.origin === new URL(SITE).origin ? decodeURIComponent(url.pathname).replace(/^\//, '') : '';
  } catch { return ''; }
}
function meaningfulText(value) {
  return typeof value === 'string' && !!value.replace(/<!--[\s\S]*?(?:-->|$)/g, '').trim();
}
function usableLink(value) {
  if (typeof value !== 'string' || !value.trim() || /[\\\u0000-\u001f]/.test(value)) return false;
  try { return ['http:', 'https:'].includes(new URL(value, SITE).protocol); } catch { return false; }
}
function jsonUpdate(path, value) {
  return { path, mode: '100644', type: 'blob', content: JSON.stringify(value, null, 2) + '\n' };
}

function base64(bytes) {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}
export async function sourceDigest(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

/** The publishing credential lives only in this instance; never in browser storage. */
export class GitHubPublisher {
  #token = '';
  #connected = false;
  #fetch;
  #publishing = false;
  // Browser fetch is a Window method: never invoke it with this publisher as its receiver.
  constructor(fetcher = (...args) => globalThis.fetch(...args)) { this.#fetch = fetcher; }
  get connected() { return this.#connected; }
  disconnect() { this.#token = ''; this.#connected = false; }

  async #request(path, method = 'GET', body) {
    if (!this.#token) throw new PublishError('Connect your publishing account first.', 'not-connected');
    if (!path.startsWith('/') || path.startsWith('//') || /[\\\s]/.test(path)) throw new PublishError('Invalid API path.');
    let response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
      response = await this.#fetch(API + path, {
        method, signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.#token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    } catch (error) {
      const timedOut = controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError';
      if (!this.#connected) {
        throw new PublishError(timedOut
          ? 'Connecting to GitHub timed out. No file was uploaded. Please try again.'
          : 'Could not connect to GitHub. No file was uploaded. Reload this page and try again.', timedOut ? 'timeout' : 'network');
      }
      throw new PublishError(timedOut
        ? 'The GitHub request timed out. Check the current note or build details before retrying; a save may already have completed.'
        : 'The GitHub request was interrupted. Check the current note or build details before retrying; a save may already have completed.', timedOut ? 'timeout' : 'network');
    }
    finally { clearTimeout(timeout); }
    if (!response.ok) {
      if (response.status === 401) { this.disconnect(); throw new PublishError('This publishing token is invalid or expired. Connect again with a valid token.', 'unauthorized'); }
      if (response.status === 403 || response.status === 404) throw new PublishError('GitHub did not allow this operation. Check that the token selects Hestious.github.io with Contents: Read and write, and has not expired or reached its request limit.', 'forbidden');
      if ((response.status === 409 || response.status === 422) && path.endsWith('/git/refs/heads/main')) throw new PublishError('The repository changed while you were uploading. Nothing was overwritten. Click Publish again to retry from the latest version.', 'conflict');
      if (response.status === 413) throw new PublishError('GitHub rejected the upload size. Use a smaller ZIP.', 'too-large');
      throw new PublishError(`GitHub could not finish this operation (HTTP ${response.status}). Your upload has not been confirmed; check the current note before retrying.`, 'request-failed');
    }
    return response.json();
  }

  async connect(token) {
    this.disconnect();
    const value = String(token || '').trim();
    if (!/^github_pat_[A-Za-z0-9_]+$/.test(value)) throw new PublishError('Enter a fine-grained GitHub token beginning with github_pat_.', 'invalid-token');
    this.#token = value;
    try {
      const user = await this.#request('/user');
      if (String(user.login).toLowerCase() !== 'hestious') throw new PublishError('This homepage can be published only by the Hestious account.', 'wrong-account');
      const repo = await this.#request(PREFIX);
      if (repo.full_name?.toLowerCase() !== REPOSITORY.toLowerCase() || repo.permissions?.push !== true) throw new PublishError('This account does not have write access to the homepage repository.', 'no-write-access');
      this.#connected = true;
      return { login: user.login };
    } catch (error) { this.disconnect(); throw error; }
  }

  #requireConnection() {
    if (!this.#connected) throw new PublishError('Connect your publishing account first.', 'not-connected');
  }

  #beginChange() {
    this.#requireConnection();
    if (this.#publishing) throw new PublishError('A change is already being saved. Wait for it to finish.', 'busy');
    this.#publishing = true;
  }

  async #snapshot() {
    const ref = await this.#request(`${PREFIX}/git/ref/heads/main`);
    if (!SHA.test(ref.object?.sha)) throw new PublishError('The publishing branch could not be read.');
    const parent = ref.object.sha;
    const commit = await this.#request(`${PREFIX}/git/commits/${parent}`);
    if (!SHA.test(commit.tree?.sha)) throw new PublishError('The homepage file tree could not be read.');
    const tree = await this.#request(`${PREFIX}/git/trees/${commit.tree.sha}?recursive=1`);
    if (tree.truncated || !Array.isArray(tree.tree)) throw new PublishError('The complete homepage file tree could not be read. No changes were published.', 'tree-incomplete');
    const entries = new Map();
    for (const entry of tree.tree) {
      if (entry.type === 'blob' && typeof entry.path === 'string' && SHA.test(entry.sha)) entries.set(entry.path, entry);
    }
    return { parent, treeSha: commit.tree.sha, entries, texts: new Map() };
  }

  #file(snapshot, path) {
    const entry = snapshot.entries.get(path);
    if (entry?.mode && !['100644', '100755'].includes(entry.mode)) throw new PublishError(`The file ${path} is not a regular homepage file. No changes were published.`, 'unsafe-path');
    return entry;
  }

  async #readText(snapshot, path, optional = false) {
    if (snapshot.texts.has(path)) return snapshot.texts.get(path);
    const entry = this.#file(snapshot, path);
    if (!entry) {
      if (optional) return '';
      throw new PublishError(`The homepage file ${path} is missing. No changes were published.`, 'invalid-content');
    }
    if (entry.size > MAX_TEXT_BYTES) throw new PublishError(`The homepage file ${path} is too large to edit here.`, 'invalid-content');
    const blob = await this.#request(`${PREFIX}/git/blobs/${entry.sha}`);
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string' || blob.content.length > Math.ceil(MAX_TEXT_BYTES * 1.4)) throw new PublishError(`The homepage file ${path} could not be read safely.`, 'invalid-content');
    let value;
    try {
      const bytes = Uint8Array.from(atob(blob.content.replace(/\s/g, '')), character => character.charCodeAt(0));
      if (bytes.length > MAX_TEXT_BYTES) throw new Error('Oversized content');
      value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch { throw new PublishError(`The homepage file ${path} is not valid UTF-8 text.`, 'invalid-content'); }
    snapshot.texts.set(path, value);
    return value;
  }

  async #readJson(snapshot, path) {
    const text = await this.#readText(snapshot, path);
    try { return JSON.parse(text); }
    catch { throw new PublishError(`The homepage file ${path} contains invalid JSON. No changes were published.`, 'invalid-content'); }
  }

  async #commitChanges(snapshot, updates, message, onProgress) {
    onProgress('Saving the homepage changes…');
    const tree = await this.#request(`${PREFIX}/git/trees`, 'POST', { base_tree: snapshot.treeSha, tree: updates });
    if (!SHA.test(tree.sha)) throw new PublishError('GitHub could not prepare the homepage changes.');
    const commit = await this.#request(`${PREFIX}/git/commits`, 'POST', { message, tree: tree.sha, parents: [snapshot.parent] });
    if (!SHA.test(commit.sha)) throw new PublishError('GitHub could not save the homepage changes.');
    // All files change together. A concurrent update is rejected; it is never overwritten.
    const updated = await this.#request(`${PREFIX}/git/refs/heads/main`, 'PATCH', { sha: commit.sha, force: false });
    if (updated.object?.sha !== commit.sha) throw new PublishError('The branch update was not confirmed. Check the homepage before retrying.', 'unconfirmed');
    return commit.sha;
  }

  async #notePdf(snapshot, topic) {
    const notes = await this.#readJson(snapshot, 'content/notes.json');
    const publications = await this.#readJson(snapshot, 'content/publications.json');
    const profile = await this.#readJson(snapshot, 'content/profile.json');
    if (!Array.isArray(notes) || !Array.isArray(publications) || !profile || typeof profile !== 'object' || Array.isArray(profile) || notes.some(note => !note || typeof note !== 'object' || Array.isArray(note)) || publications.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new PublishError('The homepage content has an unexpected format. No changes were published.', 'invalid-content');
    const matches = notes.filter(note => note.id === topic);
    if (matches.length !== 1) throw new PublishError('Choose an existing lecture-note topic.', 'invalid-topic');
    const note = matches[0];
    if (note.pdfUrl !== undefined && typeof note.pdfUrl !== 'string') throw new PublishError('This note has an invalid PDF link. No changes were published.', 'invalid-content');
    const pdfUrl = note.pdfUrl || '';
    const managed = managedPdf(pdfUrl);
    const file = managed ? this.#file(snapshot, pdfUrl) : undefined;
    const shared = new Set();
    if (managed) {
      for (const other of notes) {
        if ((other !== note && localReference(other.pdfUrl) === pdfUrl) || localReference(other.externalUrl) === pdfUrl || localReference(other.webUrl) === pdfUrl) shared.add(String(other.title || other.id || 'Another lecture note'));
      }
      for (const publication of publications) {
        if (['pdfUrl', 'url', 'externalUrl'].some(key => localReference(publication[key]) === pdfUrl)) shared.add(String(publication.title || 'A publication'));
      }
      if (profile.links !== undefined && !Array.isArray(profile.links)) throw new PublishError('The profile links have an unexpected format. No changes were published.', 'invalid-content');
      for (const link of profile.links || []) {
        if (localReference(link?.url) === pdfUrl) shared.add(String(link.label || link.title || 'A profile link'));
      }
    }
    const folder = `sources/${topic}/`;
    let hasOtherContent = [...snapshot.entries.values()].some(entry => entry.path.startsWith(folder) && !entry.path.slice(folder.length).includes('/') && /\.zip$/i.test(entry.path) && (!entry.mode || ['100644', '100755'].includes(entry.mode)));
    hasOtherContent ||= meaningfulText(note.body);
    hasOtherContent ||= ['externalUrl', 'webUrl'].some(key => usableLink(note[key]) && (!pdfUrl || localReference(note[key]) !== pdfUrl));
    if (!hasOtherContent && typeof note.bodyFile === 'string' && /^notes\/[A-Za-z0-9_./-]+\.md$/i.test(note.bodyFile) && !note.bodyFile.split('/').some(part => part === '..' || part === '.' || !part)) {
      hasOtherContent = meaningfulText(await this.#readText(snapshot, note.bodyFile, true));
    }
    return { notes, note, summary: { topic, title: String(note.title || topic), pdfUrl, pdfSha: file?.sha || '', exists: !!file, managed, sharedBy: [...shared], hasOtherContent } };
  }

  async getNotePdf({ topic }) {
    this.#requireConnection();
    if (!TOPIC.test(topic)) throw new PublishError('Choose a valid lecture-note topic.', 'invalid-topic');
    const snapshot = await this.#snapshot();
    return (await this.#notePdf(snapshot, topic)).summary;
  }

  async deleteNotePdf({ topic, expectedPdfUrl, expectedPdfSha, onProgress = () => {} }) {
    this.#requireConnection();
    if (!TOPIC.test(topic)) throw new PublishError('Choose a valid lecture-note topic.', 'invalid-topic');
    if (typeof expectedPdfUrl !== 'string' || typeof expectedPdfSha !== 'string' || (expectedPdfSha && !SHA.test(expectedPdfSha))) throw new PublishError('Check the current PDF before deleting it.', 'stale-resource');
    this.#beginChange();
    try {
      onProgress('Checking the current PDF and other references…');
      const snapshot = await this.#snapshot();
      const { notes, note, summary } = await this.#notePdf(snapshot, topic);
      if (summary.pdfUrl !== expectedPdfUrl || summary.pdfSha !== expectedPdfSha) throw new PublishError('This PDF changed since you checked it. Check the current PDF again before deleting.', 'stale-resource');
      if (!summary.pdfUrl) throw new PublishError('This note does not have a PDF to delete.', 'no-pdf');
      if (!summary.managed) throw new PublishError('Only PDF files stored directly in assets/pdfs can be deleted here.', 'unsafe-path');
      if (summary.sharedBy.length) throw new PublishError(`This PDF is also linked from ${summary.sharedBy.join(', ')}. Update those links before deleting it.`, 'shared-pdf');
      note.pdfUrl = '';
      if (note.status !== 'draft') note.status = summary.hasOtherContent ? 'available' : 'coming-soon';
      note.updatedAt = new Date().toISOString().slice(0, 10);
      const updates = [jsonUpdate('content/notes.json', notes)];
      if (summary.exists) updates.push({ path: summary.pdfUrl, mode: '100644', type: 'blob', sha: null });
      const commit = await this.#commitChanges(snapshot, updates, `Remove lecture-note PDF: ${topic}`, onProgress);
      return { commit, kind: 'delete-pdf', topic, pdfUrl: '' };
    } finally { this.#publishing = false; }
  }

  async #canRemovePhoto(snapshot, path, profile) {
    if (typeof path !== 'string' || !MANAGED_PHOTO.test(path) || !this.#file(snapshot, path)) return false;
    // Old portraits are disposable only when no structured content still uses them.
    if (profile.links !== undefined && !Array.isArray(profile.links)) return false;
    if ((profile.links || []).some(link => localReference(link?.url) === path)) return false;
    const notes = await this.#readJson(snapshot, 'content/notes.json');
    const publications = await this.#readJson(snapshot, 'content/publications.json');
    if (!Array.isArray(notes) || !Array.isArray(publications)) return false;
    return ![...notes, ...publications].some(item => !item || typeof item !== 'object' || ['pdfUrl', 'externalUrl', 'webUrl', 'url'].some(key => localReference(item[key]) === path));
  }

  async updateProfilePhoto({ bytes, filename, alt = '', onProgress = () => {} }) {
    this.#requireConnection();
    const format = validatePhoto(bytes, filename);
    if (typeof alt !== 'string' || alt.length > 300) throw new PublishError('Use a short photograph description of at most 300 characters.', 'invalid-content');
    this.#beginChange();
    try {
      onProgress('Checking the current profile…');
      const snapshot = await this.#snapshot();
      const profile = await this.#readJson(snapshot, 'content/profile.json');
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new PublishError('The profile has an unexpected format. No changes were published.', 'invalid-content');
      const previous = profile.photoUrl;
      const photoUrl = `assets/profile/photo-${await sourceDigest(bytes)}.${format.extension}`;
      const photoAlt = alt.trim() || 'Profile photograph';
      const removePrevious = previous !== photoUrl && await this.#canRemovePhoto(snapshot, previous, profile);
      onProgress('Uploading the photograph…');
      const blob = await this.#request(`${PREFIX}/git/blobs`, 'POST', { encoding: 'base64', content: base64(bytes) });
      if (!SHA.test(blob.sha)) throw new PublishError('GitHub returned an invalid photograph response.');
      profile.photoUrl = photoUrl;
      profile.photoAlt = photoAlt;
      const updates = [jsonUpdate('content/profile.json', profile), { path: photoUrl, mode: '100644', type: 'blob', sha: blob.sha }];
      if (removePrevious) updates.push({ path: previous, mode: '100644', type: 'blob', sha: null });
      const commit = await this.#commitChanges(snapshot, updates, 'Update profile photograph', onProgress);
      return { commit, kind: 'profile-photo', photoUrl, photoAlt };
    } finally { this.#publishing = false; }
  }

  async removeProfilePhoto({ expectedPhotoUrl, onProgress = () => {} }) {
    this.#requireConnection();
    if (typeof expectedPhotoUrl !== 'string' || !expectedPhotoUrl) throw new PublishError('Check the current photograph before removing it.', 'stale-resource');
    this.#beginChange();
    try {
      onProgress('Checking the current profile photograph…');
      const snapshot = await this.#snapshot();
      const profile = await this.#readJson(snapshot, 'content/profile.json');
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new PublishError('The profile has an unexpected format. No changes were published.', 'invalid-content');
      if (profile.photoUrl !== expectedPhotoUrl) throw new PublishError('The photograph changed since you checked it. Reload the current profile before removing it.', 'stale-resource');
      const removePrevious = await this.#canRemovePhoto(snapshot, expectedPhotoUrl, profile);
      profile.photoUrl = '';
      profile.photoAlt = '';
      const updates = [jsonUpdate('content/profile.json', profile)];
      if (removePrevious) updates.push({ path: expectedPhotoUrl, mode: '100644', type: 'blob', sha: null });
      const commit = await this.#commitChanges(snapshot, updates, 'Remove profile photograph', onProgress);
      return { commit, kind: 'profile-photo', photoUrl: '', photoAlt: '' };
    } finally { this.#publishing = false; }
  }

  async publish({ topic, title, bytes, filename, onProgress = () => {} }) {
    if (!this.#connected) throw new PublishError('Connect your publishing account first.', 'not-connected');
    if (this.#publishing) throw new PublishError('An upload is already in progress.', 'busy');
    if (!TOPIC.test(topic)) throw new PublishError('Choose a valid lecture-note topic.', 'invalid-topic');
    validateZip(bytes, filename);
    this.#publishing = true;
    try {
      const sourceSha256 = await sourceDigest(bytes);
      onProgress('Uploading your ZIP…');
      const blob = await this.#request(`${PREFIX}/git/blobs`, 'POST', { encoding: 'base64', content: base64(bytes) });
      if (!SHA.test(blob.sha)) throw new PublishError('GitHub returned an invalid upload response.');
      const ref = await this.#request(`${PREFIX}/git/ref/heads/main`);
      if (!SHA.test(ref.object?.sha)) throw new PublishError('The publishing branch could not be read.');
      const parent = ref.object.sha;
      const commit = await this.#request(`${PREFIX}/git/commits/${parent}`);
      if (!SHA.test(commit.tree?.sha)) throw new PublishError('The homepage file tree could not be read.');
      const tree = await this.#request(`${PREFIX}/git/trees/${commit.tree.sha}?recursive=1`);
      if (tree.truncated || !Array.isArray(tree.tree)) throw new PublishError('The repository is too large for this uploader. No changes were published.', 'tree-incomplete');
      const folder = `sources/${topic}/`;
      const target = folder + 'source.zip';
      const updates = tree.tree.filter(item => item.type === 'blob' && typeof item.path === 'string' && item.path.startsWith(folder) && !item.path.slice(folder.length).includes('/') && /\.zip$/i.test(item.path) && item.path !== target)
        .map(item => ({ path: item.path, mode: '100644', type: 'blob', sha: null }));
      updates.push({ path: target, mode: '100644', type: 'blob', sha: blob.sha });
      onProgress('Saving the note for conversion…');
      const nextTree = await this.#request(`${PREFIX}/git/trees`, 'POST', { base_tree: commit.tree.sha, tree: updates });
      if (!SHA.test(nextTree.sha)) throw new PublishError('GitHub could not prepare the updated note.');
      const nextCommit = await this.#request(`${PREFIX}/git/commits`, 'POST', { message: `Publish LaTeX note: ${String(title || topic).replace(/[\r\n]/g, ' ').slice(0, 150)}`, tree: nextTree.sha, parents: [parent] });
      if (!SHA.test(nextCommit.sha)) throw new PublishError('GitHub could not save the note.');
      // Never force: a concurrent branch update must fail instead of overwriting it.
      const updated = await this.#request(`${PREFIX}/git/refs/heads/main`, 'PATCH', { sha: nextCommit.sha, force: false });
      if (updated.object?.sha !== nextCommit.sha) throw new PublishError('The branch update was not confirmed. Check the current note before retrying.', 'unconfirmed');
      return { commit: nextCommit.sha, sourceSha256, topic };
    } finally { this.#publishing = false; }
  }
}

/** Build metadata is public; publishing credentials are never sent by this helper. */
export async function publicationRun(commit, fetcher = fetch) {
  if (!SHA.test(commit)) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  let response;
  try {
    response = await fetcher(`${API}${PREFIX}/actions/runs?head_sha=${commit}&per_page=5`, { signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store', headers: { Accept: 'application/vnd.github+json' } });
  } finally { clearTimeout(timeout); }
  if (!response.ok) return null;
  const data = await response.json();
  return (data.workflow_runs || []).find(run => run.name === 'Publish research homepage') || null;
}
