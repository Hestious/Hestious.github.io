import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto, createHash } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const source = await readFile(new URL('../assets/github-publisher.js', import.meta.url), 'utf8');
const { GitHubPublisher, validateZip, validatePhoto, sourceDigest, publicationRun, REPOSITORY, MAX_PHOTO_BYTES } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const TOKEN = 'github_pat_test_credential';
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), D = 'd'.repeat(40), E = 'e'.repeat(40);
const ZIP = Uint8Array.from([80, 75, 3, 4, 1, 2, 3]);
const repo = { full_name: REPOSITORY, permissions: { push: true } };
function mocked(responses) {
  const calls = [];
  return { calls, fetcher: async (url, options = {}) => {
    calls.push({ url, ...options, body: options.body ? JSON.parse(options.body) : undefined });
    const next = responses.shift();
    assert.ok(next, `Unexpected API call ${url}`);
    return { ok: next.status === undefined || next.status < 400, status: next.status || 200, json: async () => next.data };
  } };
}
function happyResponses() {
  return [{ data: { login: 'Hestious' } }, { data: repo }, { data: { sha: A } }, { data: { object: { sha: B } } }, { data: { tree: { sha: C } } }, { data: { truncated: false, tree: [
    { type: 'blob', path: 'sources/kd-distribution/old.ZIP', sha: A },
    { type: 'blob', path: 'sources/kd-distribution/README.md', sha: A },
    { type: 'blob', path: 'sources/optimal-transport/notes.zip', sha: A },
    { type: 'blob', path: 'assets/pdfs/von-neumann-algebra.pdf', sha: A }
  ] } }, { data: { sha: D } }, { data: { sha: E } }, { data: { object: { sha: E } } }];
}

test('publishes ZIP atomically, scopes replacement to selected topic, and keeps credentials on API origin', async () => {
  const mock = mocked(happyResponses()); const publisher = new GitHubPublisher(mock.fetcher);
  await publisher.connect(TOKEN);
  const result = await publisher.publish({ topic: 'kd-distribution', title: 'KD distribution', bytes: ZIP, filename: 'my-note.zip' });
  assert.equal(result.commit, E); assert.match(result.sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(mock.calls.length, 9);
  for (const call of mock.calls) {
    assert.equal(new URL(call.url).origin, 'https://api.github.com');
    assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(call.credentials, 'omit'); assert.equal(call.redirect, 'error');
    assert.ok(!call.url.includes(TOKEN)); assert.ok(!JSON.stringify(call.body || '').includes(TOKEN));
  }
  const tree = mock.calls.find(call => call.method === 'POST' && call.url.endsWith('/git/trees'));
  assert.equal(tree.body.base_tree, C);
  assert.deepEqual(tree.body.tree, [
    { path: 'sources/kd-distribution/old.ZIP', mode: '100644', type: 'blob', sha: null },
    { path: 'sources/kd-distribution/source.zip', mode: '100644', type: 'blob', sha: A }
  ]);
  assert.deepEqual(mock.calls[7].body.parents, [B]);
  assert.deepEqual(mock.calls[8].body, { sha: E, force: false });
  publisher.disconnect(); assert.equal(publisher.connected, false);
  await assert.rejects(publisher.publish({ topic: 'kd-distribution', bytes: ZIP, filename: 'x.zip' }), error => error.code === 'not-connected');
});

test('concurrent branch update is rejected without any force retry', async () => {
  const responses = happyResponses(); responses[8] = { status: 422, data: { message: 'Update is not a fast forward' } };
  const mock = mocked(responses); const publisher = new GitHubPublisher(mock.fetcher); await publisher.connect(TOKEN);
  await assert.rejects(publisher.publish({ topic: 'kd-distribution', bytes: ZIP, filename: 'x.zip' }), error => error.code === 'conflict');
  assert.equal(mock.calls.filter(call => call.method === 'PATCH').length, 1);
  assert.equal(mock.calls.at(-1).body.force, false);
});

test('wrong GitHub account cannot connect or publish', async () => {
  const mock = mocked([{ data: { login: 'someone-else' } }]); const publisher = new GitHubPublisher(mock.fetcher);
  await assert.rejects(publisher.connect(TOKEN), error => error.code === 'wrong-account');
  assert.equal(publisher.connected, false); assert.equal(mock.calls.length, 1);
});

test('missing repository write access fails account connection', async () => {
  const mock = mocked([{ data: { login: 'Hestious' } }, { data: { full_name: REPOSITORY, permissions: { push: false } } }]);
  const publisher = new GitHubPublisher(mock.fetcher);
  await assert.rejects(publisher.connect(TOKEN), error => error.code === 'no-write-access');
  assert.equal(publisher.connected, false);
});

test('denied blob upload never changes a tree, commit, or branch', async () => {
  const mock = mocked([{ data: { login: 'Hestious' } }, { data: repo }, { status: 403, data: { message: 'denied' } }]);
  const publisher = new GitHubPublisher(mock.fetcher); await publisher.connect(TOKEN);
  await assert.rejects(publisher.publish({ topic: 'kd-distribution', bytes: ZIP, filename: 'x.zip' }), error => error.code === 'forbidden');
  assert.equal(mock.calls.length, 3); assert.ok(mock.calls.at(-1).url.endsWith('/git/blobs'));
});

test('path traversal and non-ZIP content are rejected before publishing', async () => {
  const mock = mocked([{ data: { login: 'Hestious' } }, { data: repo }]); const publisher = new GitHubPublisher(mock.fetcher); await publisher.connect(TOKEN);
  await assert.rejects(publisher.publish({ topic: '../.github/workflows', bytes: ZIP, filename: 'x.zip' }), error => error.code === 'invalid-topic');
  await assert.rejects(publisher.publish({ topic: 'kd-distribution', bytes: new Uint8Array([1, 2, 3, 4]), filename: 'x.zip' }), error => error.code === 'invalid-file');
  assert.equal(mock.calls.length, 2);
  assert.throws(() => validateZip(new Uint8Array(25 * 1024 * 1024 + 1), 'x.zip'), error => error.code === 'invalid-file');
});

test('incomplete tree response fails without replacing any repository content', async () => {
  const responses = happyResponses(); responses[5] = { data: { truncated: true, tree: [] } };
  const mock = mocked(responses); const publisher = new GitHubPublisher(mock.fetcher); await publisher.connect(TOKEN);
  await assert.rejects(publisher.publish({ topic: 'kd-distribution', bytes: ZIP, filename: 'x.zip' }), error => error.code === 'tree-incomplete');
  assert.equal(mock.calls.length, 6);
});

test('public build-status requests contain no publishing credential', async () => {
  const mock = mocked([{ data: { workflow_runs: [{ id: 123, name: 'Publish research homepage', status: 'completed', conclusion: 'success' }] } }]);
  const result = await publicationRun(E, mock.fetcher);
  assert.equal(result.id, 123); assert.equal(mock.calls[0].headers.Authorization, undefined);
  assert.equal(await publicationRun('bad/path', mock.fetcher), null); assert.equal(mock.calls.length, 1);
});

test('publisher implementation never persists or logs the credential', () => {
  assert.ok(!/localStorage|sessionStorage|console\./.test(source));
  assert.ok(source.includes('#token')); assert.ok(source.includes('this.#token = \'\''));
});


test('default browser fetch keeps its required global receiver', async () => {
  const original = globalThis.fetch;
  let count = 0;
  globalThis.fetch = function (url, options) {
    assert.equal(this, globalThis, 'Window.fetch must not receive the publisher instance as this');
    assert.equal(options.headers['X-GitHub-Api-Version'], '2022-11-28');
    const data = ++count === 1 ? { login: 'Hestious' } : repo;
    return Promise.resolve({ ok: true, status: 200, json: async () => data });
  };
  try {
    const publisher = new GitHubPublisher();
    await publisher.connect(TOKEN);
    assert.equal(publisher.connected, true);
    assert.equal(count, 2);
    publisher.disconnect();
  } finally { globalThis.fetch = original; }
});

test('connection failure explains that no upload occurred', async () => {
  const publisher = new GitHubPublisher(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(publisher.connect(TOKEN), error => error.code === 'network' && /No file was uploaded/.test(error.message));
  assert.equal(publisher.connected, false);
});

test('connection timeout is distinct from a network error', async () => {
  const publisher = new GitHubPublisher(async () => { throw new DOMException('The operation was aborted.', 'AbortError'); });
  await assert.rejects(publisher.connect(TOKEN), error => error.code === 'timeout' && /timed out/.test(error.message) && /No file was uploaded/.test(error.message));
  assert.equal(publisher.connected, false);
});

const PDF = 'assets/pdfs/von-neumann-algebra.pdf';
const TOPIC = 'von-neumann-algebra';
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'));
const originalProfile = { name: 'A researcher', role: 'Physics', bio: 'My biography', links: [{ label: 'Scholar', url: 'https://example.org/' }], extra: { preserve: true } };
const originalNote = { id: TOPIC, title: 'von Neumann algebra', pdfUrl: PDF, externalUrl: '', bodyFile: 'notes/von-neumann-algebra.md', status: 'available', extra: { preserve: true } };

// The fixture serves immutable blobs from a single main-branch snapshot, like Git's
// database API. Writes are recorded but never sent to GitHub or applied to user data.
function database({ notes = [originalNote], publications = [], profile = originalProfile, files = {}, patchStatus = 200, blobStatus = 200 } = {}) {
  const contents = {
    'content/notes.json': JSON.stringify(notes),
    'content/publications.json': JSON.stringify(publications),
    'content/profile.json': JSON.stringify(profile),
    [PDF]: '%PDF-1.7 fixture',
    'notes/von-neumann-algebra.md': '<!-- Instructions only; not a published note. -->\n',
    ...files
  };
  const blobs = new Map(), tree = [], calls = [];
  for (const [path, content] of Object.entries(contents)) {
    if (content === null) continue;
    const bytes = Buffer.from(content);
    const sha = createHash('sha1').update(path).update(bytes).digest('hex');
    blobs.set(sha, { encoding: 'base64', content: bytes.toString('base64'), size: bytes.length });
    tree.push({ path, type: 'blob', mode: '100644', sha, size: bytes.length });
  }
  const fetcher = async (url, options = {}) => {
    const call = { url, ...options, body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    const path = new URL(url).pathname.replace(`/repos/${REPOSITORY}`, '');
    let data, status = 200;
    if (path === '/user') data = { login: 'Hestious' };
    else if (path === '') data = repo;
    else if (path === '/git/ref/heads/main') data = { object: { sha: B } };
    else if (path === `/git/commits/${B}`) data = { tree: { sha: C } };
    else if (path === `/git/trees/${C}`) data = { truncated: false, tree };
    else if (path.startsWith('/git/blobs/') && options.method === 'GET') data = blobs.get(path.split('/').at(-1));
    else if (path === '/git/blobs' && options.method === 'POST') { data = { sha: A }; status = blobStatus; }
    else if (path === '/git/trees' && options.method === 'POST') data = { sha: D };
    else if (path === '/git/commits' && options.method === 'POST') data = { sha: E };
    else if (path === '/git/refs/heads/main' && options.method === 'PATCH') { data = { object: { sha: E } }; status = patchStatus; }
    assert.ok(data, `Unexpected API route: ${options.method} ${path}`);
    return { ok: status < 400, status, json: async () => data };
  };
  return { calls, fetcher, tree, sha: path => tree.find(entry => entry.path === path)?.sha || '' };
}
async function connectedDatabase(options) {
  const mock = database(options); const publisher = new GitHubPublisher(mock.fetcher);
  await publisher.connect(TOKEN); return { ...mock, publisher };
}
function writes(mock) { return mock.calls.filter(call => ['POST', 'PATCH'].includes(call.method)); }
function treeChanges(mock) { return mock.calls.find(call => call.method === 'POST' && call.url.endsWith('/git/trees')).body.tree; }
function editedJson(mock, path) { return JSON.parse(treeChanges(mock).find(entry => entry.path === path).content); }

test('PDF inspection reads current Git snapshot, source digest, and meaningful-content state without writes', async () => {
  const mock = await connectedDatabase();
  const result = await mock.publisher.getNotePdf({ topic: TOPIC });
  assert.deepEqual(result, { topic: TOPIC, title: 'von Neumann algebra', pdfUrl: PDF, pdfSha: mock.sha(PDF), exists: true, managed: true, sharedBy: [], hasOtherContent: false });
  assert.equal(writes(mock).length, 0);
  assert.ok(mock.calls.some(call => call.url.endsWith('/git/ref/heads/main')));
  assert.ok(mock.calls.some(call => call.url.endsWith('/git/blobs/' + mock.sha('content/notes.json'))));
});

test('PDF removal changes only selected note and PDF in one non-forced commit', async () => {
  const other = { id: 'holography', title: 'Holography', pdfUrl: '', status: 'coming-soon', extra: ['keep'] };
  const mock = await connectedDatabase({ notes: [originalNote, other] });
  const result = await mock.publisher.deleteNotePdf({ topic: TOPIC, expectedPdfUrl: PDF, expectedPdfSha: mock.sha(PDF) });
  assert.deepEqual(result, { commit: E, kind: 'delete-pdf', topic: TOPIC, pdfUrl: '' });
  const notes = editedJson(mock, 'content/notes.json');
  assert.equal(notes[0].pdfUrl, ''); assert.equal(notes[0].status, 'coming-soon');
  assert.deepEqual(notes[0].extra, originalNote.extra); assert.deepEqual(notes[1], other);
  assert.match(notes[0].updatedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(treeChanges(mock).map(({ path, sha }) => ({ path, sha })), [{ path: 'content/notes.json', sha: undefined }, { path: PDF, sha: null }]);
  assert.equal(writes(mock).length, 3);
  assert.equal(writes(mock)[0].body.base_tree, C);
  assert.deepEqual(writes(mock)[1].body.parents, [B]);
  assert.deepEqual(writes(mock)[2].body, { sha: E, force: false });
});

test('PDF deletion preserves availability when ZIP, Markdown, or external content survives', async () => {
  const cases = [
    { files: { 'sources/von-neumann-algebra/research.ZIP': ZIP } },
    { files: { 'notes/von-neumann-algebra.md': '<!-- setup -->\n# Lecture\nA mathematical statement.' } },
    { notes: [{ ...originalNote, externalUrl: 'https://example.org/notes' }] },
    { notes: [{ ...originalNote, body: 'Inline lecture content.' }] }
  ];
  for (const options of cases) {
    const mock = await connectedDatabase(options);
    const inspected = await mock.publisher.getNotePdf({ topic: TOPIC });
    assert.equal(inspected.hasOtherContent, true);
    await mock.publisher.deleteNotePdf({ topic: TOPIC, expectedPdfUrl: PDF, expectedPdfSha: mock.sha(PDF) });
    assert.equal(editedJson(mock, 'content/notes.json')[0].status, 'available');
    assert.ok(!treeChanges(mock).some(change => change.path.startsWith('sources/') || change.path.startsWith('notes/')));
  }
});

test('PDF deletion does not publish a draft or mistake unrelated or comment-only content for notes', async () => {
  for (const status of ['draft', 'available']) {
    const mock = await connectedDatabase({ notes: [{ ...originalNote, status }], files: { 'sources/holography/source.zip': ZIP, 'sources/von-neumann-algebra/nested/source.zip': ZIP } });
    await mock.publisher.deleteNotePdf({ topic: TOPIC, expectedPdfUrl: PDF, expectedPdfSha: mock.sha(PDF) });
    assert.equal(editedJson(mock, 'content/notes.json')[0].status, status === 'draft' ? 'draft' : 'coming-soon');
  }
});

test('shared PDFs referenced by notes, publications, or profile links cannot be deleted', async () => {
  const cases = [
    { notes: [originalNote, { id: 'holography', title: 'Shared note', pdfUrl: PDF }], label: 'Shared note' },
    { publications: [{ title: 'Shared publication', pdfUrl: 'https://hestious.github.io/' + PDF + '?download=1' }], label: 'Shared publication' },
    { profile: { ...originalProfile, links: [{ label: 'CV link', url: '/assets/pdfs/von%2Dneumann-algebra.pdf#page=2' }] }, label: 'CV link' },
    { notes: [{ ...originalNote, externalUrl: '/' + PDF }], label: originalNote.title }
  ];
  for (const { label, ...options } of cases) {
    const mock = await connectedDatabase(options);
    assert.ok((await mock.publisher.getNotePdf({ topic: TOPIC })).sharedBy.includes(label));
    await assert.rejects(mock.publisher.deleteNotePdf({ topic: TOPIC, expectedPdfUrl: PDF, expectedPdfSha: mock.sha(PDF) }), error => error.code === 'shared-pdf' && error.message.includes(label));
    assert.equal(writes(mock).length, 0);
  }
});

test('PDF deletion requires both unchanged path and unchanged blob SHA', async () => {
  for (const expected of [{ expectedPdfUrl: PDF }, { expectedPdfUrl: PDF, expectedPdfSha: A }, { expectedPdfUrl: 'assets/pdfs/old.pdf', expectedPdfSha: A }]) {
    const mock = await connectedDatabase();
    await assert.rejects(mock.publisher.deleteNotePdf({ topic: TOPIC, ...expected }), error => error.code === 'stale-resource');
    assert.equal(writes(mock).length, 0);
  }
});

test('unsafe or external PDF metadata cannot expand deletion scope', async () => {
  for (const path of ['assets/pdfs/../profile.json', 'assets/pdfs/nested/note.pdf', '/assets/pdfs/note.pdf', 'assets/pdfs/%2e%2e/note.pdf', 'https://example.org/note.pdf', 'assets/pdfs/note.pdf?download=1']) {
    const mock = await connectedDatabase({ notes: [{ ...originalNote, pdfUrl: path }] });
    const result = await mock.publisher.getNotePdf({ topic: TOPIC });
    assert.equal(result.managed, false);
    await assert.rejects(mock.publisher.deleteNotePdf({ topic: TOPIC, expectedPdfUrl: path, expectedPdfSha: '' }), error => error.code === 'unsafe-path');
    assert.equal(writes(mock).length, 0);
  }
});

test('missing PDF can be unlinked only with an explicit empty current SHA', async () => {
  const mock = await connectedDatabase({ files: { [PDF]: null } });
  const inspected = await mock.publisher.getNotePdf({ topic: TOPIC });
  assert.equal(inspected.exists, false); assert.equal(inspected.pdfSha, '');
  await mock.publisher.deleteNotePdf({ topic: TOPIC, expectedPdfUrl: PDF, expectedPdfSha: '' });
  assert.deepEqual(treeChanges(mock).map(change => change.path), ['content/notes.json']);
});

test('invalid and oversized photos are rejected before any upload', async () => {
  const mock = await connectedDatabase();
  for (const [bytes, filename] of [[PNG, 'photo.svg'], [new TextEncoder().encode('<svg></svg>'), 'photo.png'], [PNG, 'photo.jpg'], [new Uint8Array(MAX_PHOTO_BYTES + 1), 'photo.png']]) {
    await assert.rejects(mock.publisher.updateProfilePhoto({ bytes, filename }), error => error.code === 'invalid-file');
  }
  assert.equal(mock.calls.length, 2);
  assert.deepEqual(validatePhoto(PNG, 'portrait.PNG'), { extension: 'png', mimeType: 'image/png' });
  assert.deepEqual(validatePhoto(new Uint8Array([255, 216, 255, 224, 255, 217]), 'photo.jpeg'), { extension: 'jpg', mimeType: 'image/jpeg' });
  assert.deepEqual(validatePhoto(new TextEncoder().encode('RIFFxxxxWEBPVP8 xxxx'), 'photo.webp'), { extension: 'webp', mimeType: 'image/webp' });
});

test('photo update atomically stores immutable image and preserves profile fields', async () => {
  const previous = 'assets/profile/photo-' + '9'.repeat(64) + '.jpg';
  const mock = await connectedDatabase({ profile: { ...originalProfile, photoUrl: previous, photoAlt: 'Old photograph' }, files: { [previous]: 'old image' } });
  const result = await mock.publisher.updateProfilePhoto({ bytes: PNG, filename: '../../workflows/photo.png', alt: '  Portrait of the author  ' });
  const photoUrl = `assets/profile/photo-${await sourceDigest(PNG)}.png`;
  assert.deepEqual(result, { commit: E, kind: 'profile-photo', photoUrl, photoAlt: 'Portrait of the author' });
  assert.deepEqual(editedJson(mock, 'content/profile.json'), { ...originalProfile, photoUrl, photoAlt: 'Portrait of the author' });
  assert.deepEqual(treeChanges(mock).map(({ path, sha }) => ({ path, sha })), [
    { path: 'content/profile.json', sha: undefined }, { path: photoUrl, sha: A }, { path: previous, sha: null }
  ]);
  assert.deepEqual(writes(mock).at(-2).body.parents, [B]); assert.deepEqual(writes(mock).at(-1).body, { sha: E, force: false });
  assert.ok(writes(mock)[0].url.endsWith('/git/blobs'));
  assert.equal(writes(mock)[0].body.content, Buffer.from(PNG).toString('base64'));
});

test('photo replacement never deletes an arbitrary prior path or the same immutable image', async () => {
  const samePhoto = `assets/profile/photo-${await sourceDigest(PNG)}.png`;
  for (const previous of ['assets/pdfs/important.pdf', 'assets/profile/portrait.png', 'https://example.org/photo.png', samePhoto]) {
    const mock = await connectedDatabase({ profile: { ...originalProfile, photoUrl: previous }, files: { [previous]: 'other content' } });
    await mock.publisher.updateProfilePhoto({ bytes: PNG, filename: 'photo.png' });
    assert.ok(!treeChanges(mock).some(change => change.sha === null));
    assert.equal(editedJson(mock, 'content/profile.json').photoAlt, 'Profile photograph');
  }
});

test('photo removal verifies current URL and deletes only a managed image', async () => {
  const managed = 'assets/profile/photo-' + '8'.repeat(64) + '.webp';
  for (const previous of [managed, 'assets/profile/other.png']) {
    const mock = await connectedDatabase({ profile: { ...originalProfile, photoUrl: previous, photoAlt: 'Portrait' }, files: { [previous]: 'image' } });
    const result = await mock.publisher.removeProfilePhoto({ expectedPhotoUrl: previous });
    assert.deepEqual(result, { commit: E, kind: 'profile-photo', photoUrl: '', photoAlt: '' });
    assert.deepEqual(editedJson(mock, 'content/profile.json'), { ...originalProfile, photoUrl: '', photoAlt: '' });
    assert.equal(treeChanges(mock).filter(change => change.sha === null).length, previous === managed ? 1 : 0);
  }
  const stale = await connectedDatabase({ profile: { ...originalProfile, photoUrl: managed } });
  await assert.rejects(stale.publisher.removeProfilePhoto({ expectedPhotoUrl: 'assets/profile/old.png' }), error => error.code === 'stale-resource');
  assert.equal(writes(stale).length, 0);
});

test('replacing or removing a photo preserves its asset when another resource references it', async () => {
  const previous = 'assets/profile/photo-' + '7'.repeat(64) + '.png';
  const profile = { ...originalProfile, photoUrl: previous };
  for (const options of [
    { profile: { ...profile, links: [{ label: 'Photograph', url: '/' + previous }] } },
    { profile, notes: [{ ...originalNote, externalUrl: previous }] },
    { profile, publications: [{ title: 'Resource', url: 'https://hestious.github.io/' + previous }] }
  ]) {
    for (const method of ['updateProfilePhoto', 'removeProfilePhoto']) {
      const mock = await connectedDatabase({ ...options, files: { [previous]: 'image' } });
      await mock.publisher[method](method === 'updateProfilePhoto' ? { bytes: PNG, filename: 'photo.png' } : { expectedPhotoUrl: previous });
      assert.ok(!treeChanges(mock).some(change => change.sha === null));
      assert.notEqual(editedJson(mock, 'content/profile.json').photoUrl, previous);
    }
  }
});

test('photo failure or concurrent PDF/photo update never forces or reports success', async () => {
  const failedBlob = await connectedDatabase({ blobStatus: 403 });
  await assert.rejects(failedBlob.publisher.updateProfilePhoto({ bytes: PNG, filename: 'photo.png' }), error => error.code === 'forbidden');
  assert.equal(writes(failedBlob).length, 1);
  for (const method of ['deleteNotePdf', 'updateProfilePhoto', 'removeProfilePhoto']) {
    const mock = await connectedDatabase({ patchStatus: 422, profile: { ...originalProfile, photoUrl: 'assets/profile/portrait.png' } });
    const args = method === 'deleteNotePdf' ? { topic: TOPIC, expectedPdfUrl: PDF, expectedPdfSha: mock.sha(PDF) } : method === 'updateProfilePhoto' ? { bytes: PNG, filename: 'photo.png' } : { expectedPhotoUrl: 'assets/profile/portrait.png' };
    await assert.rejects(mock.publisher[method](args), error => error.code === 'conflict');
    assert.equal(mock.calls.filter(call => call.method === 'PATCH').length, 1);
    assert.equal(mock.calls.at(-1).body.force, false);
  }
});
