import { GitHubPublisher, MAX_ZIP_BYTES, REPO_URL, publicationRun, validateZip } from './github-publisher.js?v=20261127-connection-2';

const $ = id => document.getElementById(id);
const publisher = new GitHubPublisher();
let topics = [];
let fileBytes = null;
let fileName = '';
let fileSequence = 0;
let busy = false;
let connecting = false;
let loading = false;
let monitoring = false;
let timer;
let pending;
let watchCount = 0;

function node(tag, text, className) { const item = document.createElement(tag); if (text) item.textContent = text; if (className) item.className = className; return item; }
function link(text, href, external = false) { const item = node('a', text); item.href = href; if (external) { item.target = '_blank'; item.rel = 'noopener noreferrer'; } return item; }
function selectedTopic() { return topics.find(item => item.id === $('topic').value); }
function validWebNote(topic) { return topic?.webUrl === `notes/imported/${topic.id}/index.html`; }
function controls() {
  $('publish').disabled = busy || loading || !!pending || !publisher.connected || !fileBytes || !selectedTopic();
  $('topic').disabled = busy || loading || !topics.length;
  $('zip-file').disabled = busy;
  $('connect').disabled = busy || connecting;
  $('disconnect').disabled = busy;
  $('check-updates').disabled = loading || monitoring;
  $('disconnect').hidden = !publisher.connected;
  $('owner-workspace').hidden = !publisher.connected;
  $('owner-edit-link').hidden = !publisher.connected;
  $('publishing-token').disabled = publisher.connected || busy || connecting;
  $('connect').hidden = publisher.connected;
  $('publish-help').textContent = pending ? 'Your ZIP is saved. Waiting for the converted note to appear on the homepage.' : publisher.connected ? 'Choose a ZIP, then publish. Conversion starts automatically.' : 'Choose a ZIP and connect publishing to enable the publish button.';
}
function status(message, error = false, extras = []) {
  const box = $('publication-status'); box.hidden = false; box.className = `publication${error ? ' error' : ''}`;
  box.replaceChildren(node('p', message), ...extras);
}
function updateTopic() {
  const topic = selectedTopic(); if (!topic) return;
  const folder = `sources/${encodeURIComponent(topic.id)}`;
  $('upload-link').href = `${REPO_URL}/upload/main/${folder}`; $('upload-link').hidden = false;
  $('folder-link').href = `${REPO_URL}/tree/main/${folder}`; $('folder-link').hidden = false;
  $('topic-description').textContent = topic.description || '';
  const current = $('current-note'); current.replaceChildren();
  if (validWebNote(topic)) {
    current.append(node('p', 'Published on your homepage.', 'success'), link(`Read ${topic.title}`, topic.webUrl));
  } else current.textContent = `No converted web note has been published for ${topic.title} yet.`;
  const url = new URL(location.href); url.searchParams.set('topic', topic.id); history.replaceState(null, '', url);
  controls();
}
async function loadTopics(quiet = false) {
  if (loading) return;
  loading = true; $('load-error').hidden = true; $('retry').disabled = true; controls();
  const previous = selectedTopic()?.id || new URL(location.href).searchParams.get('topic');
  try {
    const response = await fetch(`./content/notes.json?updated=${Date.now()}`, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Topics unavailable');
    const notes = await response.json();
    if (!Array.isArray(notes)) throw new Error('Invalid topics');
    topics = notes.filter(item => item && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) && typeof item.title === 'string' && item.status !== 'draft');
    if (!topics.length) throw new Error('No topics');
    $('topic').replaceChildren(...topics.map(topic => { const option = node('option', topic.title); option.value = topic.id; return option; }));
    if (topics.some(item => item.id === previous)) $('topic').value = previous;
    updateTopic();
  } catch {
    if (!quiet || !topics.length) $('load-error').hidden = false;
  } finally { loading = false; $('retry').disabled = false; controls(); }
}
function keepPendingInURL() {
  const url = new URL(location.href);
  if (pending) { url.searchParams.set('publication', pending.commit); url.searchParams.set('source', pending.sourceSha256); url.searchParams.set('upload-topic', pending.topic); }
  else { url.searchParams.delete('publication'); url.searchParams.delete('source'); url.searchParams.delete('upload-topic'); }
  history.replaceState(null, '', url);
}
function publicationExtras(run) {
  const href = run?.id && /^\d+$/.test(String(run.id)) ? `${REPO_URL}/actions/runs/${run.id}` : `${REPO_URL}/actions`;
  return [link('View build details', href, true)];
}
async function checkPublication() {
  clearTimeout(timer);
  if (!pending || monitoring) return;
  monitoring = true; controls();
  const current = pending;
  try {
    await loadTopics(true);
    if (pending !== current) return;
    const topic = topics.find(item => item.id === current.topic);
    if (validWebNote(topic) && topic.sourceSha256 === current.sourceSha256) {
      status(`Published: ${topic.title} is now on your homepage.`, false, [link('Read the published note', topic.webUrl), node('span', ' · '), link('Open the homepage', './#notes')]);
      pending = null; keepPendingInURL(); updateTopic(); return;
    }
    let run;
    try { run = await publicationRun(current.commit); } catch { /* Publication can still be checked from public site metadata. */ }
    if (run?.status === 'completed' && run.conclusion !== 'success') {
      status(`The ZIP was saved, but conversion or publication did not finish successfully${run.conclusion ? ` (${run.conclusion})` : ''}. The previous homepage remains online. Check the build details, correct the source, and publish again.`, true, publicationExtras(run));
      pending = null; keepPendingInURL(); return;
    }
    status(run?.conclusion === 'success' ? 'Conversion succeeded. Waiting for the updated reading page to reach the public website…' : 'ZIP saved. Converting the LaTeX project and publishing your homepage…', false, publicationExtras(run));
    if (++watchCount < 60) timer = setTimeout(checkPublication, 15000);
    else status('Publication is still pending. You can leave this page open or use Check for updates later. A saved ZIP is not yet confirmation that the reading page is published.', false, publicationExtras(run));
  } finally { monitoring = false; controls(); }
}

$('connection-form').addEventListener('submit', async event => {
  event.preventDefault(); if (connecting || busy) return; connecting = true; const token = $('publishing-token').value; $('publishing-token').value = '';
  $('connect').disabled = true; $('connection-status').className = ''; $('connection-status').textContent = 'Connecting to your publishing account…'; controls();
  try {
    const account = await publisher.connect(token);
    $('connection-status').className = 'success'; $('connection-status').textContent = `Connected as ${account.login} for this open tab.`;
    $('connection-summary').textContent = 'Publishing account connected';
    try { sessionStorage.setItem('research-owner-ui', JSON.stringify({ login: 'Hestious', verifiedAt: Date.now() })); window.dispatchEvent(new Event('research-owner-ui-change')); } catch { /* Owner controls still work in this tab when storage is unavailable. */ }
  } catch (error) { $('connection-status').className = 'error'; $('connection-status').textContent = error.message; }
  finally { connecting = false; controls(); }
});
$('disconnect').addEventListener('click', () => { publisher.disconnect(); try { sessionStorage.removeItem('research-owner-ui'); window.dispatchEvent(new Event('research-owner-ui-change')); } catch {} $('publishing-token').value = ''; $('connection-status').textContent = 'Disconnected. The publishing token has been cleared.'; $('connection-status').className = ''; $('connection-summary').textContent = 'Connect your publishing account'; controls(); });
$('zip-file').addEventListener('change', async () => {
  const sequence = ++fileSequence; fileBytes = null; fileName = ''; controls();
  const file = $('zip-file').files?.[0]; if (!file) { $('file-status').textContent = ''; return; }
  $('file-status').className = 'hint';
  if (file.size > MAX_ZIP_BYTES) { $('file-status').className = 'error'; $('file-status').textContent = 'The ZIP must be 25 MB or smaller.'; return; }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer()); validateZip(bytes, file.name);
    if (sequence !== fileSequence) return;
    fileBytes = bytes; fileName = file.name; $('file-status').textContent = `${file.name} · ${(file.size / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB · ready to publish`;
  } catch (error) { if (sequence === fileSequence) { $('file-status').className = 'error'; $('file-status').textContent = error.message; } }
  controls();
});
$('publish').addEventListener('click', async () => {
  const topic = selectedTopic(); if (!topic || !fileBytes || busy || pending) return;
  busy = true; controls();
  try {
    pending = await publisher.publish({ topic: topic.id, title: topic.title, bytes: fileBytes, filename: fileName, onProgress: message => status(message) });
    watchCount = 0; keepPendingInURL(); status('ZIP saved. Conversion and homepage publication are starting…');
  } catch (error) { status(error.message, true); if (!publisher.connected) { $('connection-summary').textContent = 'Connect your publishing account'; $('connection-status').textContent = 'Please reconnect publishing.'; } }
  finally { busy = false; controls(); }
  if (pending) await checkPublication();
});
$('topic').addEventListener('change', updateTopic);
$('retry').addEventListener('click', () => loadTopics());
$('check-updates').addEventListener('click', async () => { if (pending) { watchCount = 0; await checkPublication(); } else await loadTopics(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && !busy) { if (pending) checkPublication(); else loadTopics(true); } });
window.addEventListener('pagehide', () => publisher.disconnect());
window.addEventListener('pageshow', () => { if (!publisher.connected) { $('connection-summary').textContent = 'Connect your publishing account'; $('connection-status').textContent = ''; } controls(); });
const query = new URL(location.href).searchParams;
if (/^[a-f0-9]{40}$/.test(query.get('publication') || '') && /^[a-f0-9]{64}$/.test(query.get('source') || '') && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(query.get('upload-topic') || '')) {
  pending = { commit: query.get('publication'), sourceSha256: query.get('source'), topic: query.get('upload-topic') };
}
await loadTopics();
if (pending) checkPublication();
