import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const source = await readFile(new URL('../assets/github-publisher.js', import.meta.url), 'utf8');
const { GitHubPublisher, validateZip, publicationRun, REPOSITORY } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
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
