const API = 'https://api.github.com';
export const REPOSITORY = 'Hestious/Hestious.github.io';
export const REPO_URL = `https://github.com/${REPOSITORY}`;
export const MAX_ZIP_BYTES = 25 * 1024 * 1024;
const PREFIX = `/repos/${REPOSITORY}`;
const TOPIC = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA = /^[a-f0-9]{40}$/;

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
