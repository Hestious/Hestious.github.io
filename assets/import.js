import { GitHubPublisher, MAX_ZIP_BYTES, REPOSITORY, REPO_URL, publicationRun, validateZip, validatePhoto } from './github-publisher.js?v=20261127-owner-assets-1';

const $ = id => document.getElementById(id);
const publisher = new GitHubPublisher();
let topics = [], profile = null, pdfDetails = null;
let fileBytes = null, fileName = '', fileSequence = 0;
let photoBytes = null, photoName = '', photoObjectURL = '', photoSequence = 0, pdfSequence = 0, profileSequence = 0;
let busy = false, connecting = false, loading = false, monitoring = false, pdfLoading = false, photoLoading = false, photoPreparing = false;
let timer, pending, watchCount = 0;
const SHA = /^[a-f0-9]{40}$/;
const TOPIC = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PHOTO_PATH = /^assets\/profile\/photo-[a-f0-9]{64}\.(?:jpg|jpeg|png|webp)$/;
const PDF_PATH = /^assets\/pdfs\/[A-Za-z0-9][A-Za-z0-9_. ()-]*\.pdf$/i;

function node(tag, text, className) { const item = document.createElement(tag); if (text) item.textContent = text; if (className) item.className = className; return item; }
function link(text, href, external = false) { const item = node('a', text); item.href = href; if (external) { item.target = '_blank'; item.rel = 'noopener noreferrer'; } return item; }
function selectedTopic() { return topics.find(item => item.id === $('topic').value); }
function validWebNote(topic) { return topic?.webUrl === `notes/imported/${topic.id}/index.html`; }
function safeAsset(value, pattern) { return typeof value === 'string' && pattern.test(value) && !value.includes('..') && value.length <= 240 && !value.split('/').some(part => part === '.') ? value : ''; }
function locked() { return busy || !!pending; }
function controls() {
  const lock = locked(), connected = publisher.connected;
  $('publish').disabled = lock || loading || !connected || !fileBytes || !selectedTopic();
  $('topic').disabled = lock || loading || !topics.length;
  $('zip-file').disabled = lock;
  $('connect').disabled = busy || connecting;
  $('disconnect').disabled = busy;
  $('check-updates').disabled = loading || monitoring;
  $('disconnect').hidden = !connected;
  $('owner-workspace').hidden = !connected;
  $('owner-photo-workspace').hidden = !connected;
  $('owner-edit-link').hidden = !connected;
  $('publishing-token').disabled = connected || busy || connecting;
  $('connect').hidden = connected;
  $('publish-help').textContent = pending ? 'Your change is saved. Waiting for publication before making another change.' : connected ? 'Choose a ZIP, then publish. Conversion starts automatically.' : 'Connect publishing to open the editing controls.';
  $('delete-pdf').disabled = lock || !connected || pdfLoading || !pdfDetails?.exists || !pdfDetails.pdfUrl || !!pdfDetails.sharedBy?.length;
  $('retry-pdf').disabled = lock || pdfLoading || !connected;
  $('confirm-delete-pdf').disabled = $('delete-pdf').disabled;
  $('cancel-delete-pdf').disabled = busy;
  $('photo-file').disabled = lock || photoLoading || photoPreparing || !connected;
  $('photo-alt').disabled = lock || photoLoading || !connected;
  $('publish-photo').disabled = lock || !connected || photoLoading || photoPreparing || !photoBytes || !profile;
  $('remove-photo').hidden = !profile?.photoUrl;
  $('remove-photo').disabled = lock || !connected || photoLoading || !profile?.photoUrl;
  $('confirm-remove-photo').disabled = $('remove-photo').disabled;
  $('cancel-remove-photo').disabled = busy;
  $('retry-photo').disabled = lock || photoLoading || !connected;
}
function status(message, error = false, extras = []) {
  const box = $('publication-status'); box.hidden = false; box.className = `publication${error ? ' error' : ''}`;
  box.replaceChildren(node('p', message), ...extras);
}
function closeConfirmations() { $('pdf-confirmation').hidden = true; $('photo-confirmation').hidden = true; }
function clearPhotoSelection({ clearInput = true } = {}) {
  photoSequence++; photoBytes = null; photoName = ''; photoPreparing = false;
  if (clearInput) $('photo-file').value = '';
  $('photo-preview-wrap').hidden = true; $('photo-preview').removeAttribute('src');
  if (photoObjectURL) URL.revokeObjectURL(photoObjectURL);
  photoObjectURL = '';
}
async function publicJson(path) {
  const response = await fetch(`${path}${path.includes('?') ? '&' : '?'}updated=${Date.now()}`, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('Public content unavailable');
  return response.json();
}
function updateTopic() {
  const topic = selectedTopic(); if (!topic) return;
  const folder = `sources/${encodeURIComponent(topic.id)}`;
  $('upload-link').href = `${REPO_URL}/upload/main/${folder}`; $('upload-link').hidden = false;
  $('folder-link').href = `${REPO_URL}/tree/main/${folder}`; $('folder-link').hidden = false;
  $('topic-description').textContent = topic.description || '';
  const current = $('current-note'); current.replaceChildren();
  if (validWebNote(topic)) current.append(node('p', 'Published on your homepage.', 'success'), link(`Read ${topic.title}`, topic.webUrl));
  else current.textContent = `No converted web note has been published for ${topic.title} yet.`;
  const url = new URL(location.href); url.searchParams.set('topic', topic.id); history.replaceState(null, '', url);
  closeConfirmations(); controls();
  if (publisher.connected && !pending) loadPdfDetails();
}
async function loadTopics(quiet = false) {
  if (loading) return false;
  loading = true; $('load-error').hidden = true; $('retry').disabled = true; controls();
  const previous = selectedTopic()?.id || new URL(location.href).searchParams.get('topic');
  try {
    const notes = await publicJson('./content/notes.json');
    if (!Array.isArray(notes)) throw new Error('Invalid topics');
    topics = notes.filter(item => item && TOPIC.test(item.id) && typeof item.title === 'string' && item.status !== 'draft');
    if (!topics.length) throw new Error('No topics');
    $('topic').replaceChildren(...topics.map(topic => { const option = node('option', topic.title); option.value = topic.id; return option; }));
    if (topics.some(item => item.id === previous)) $('topic').value = previous;
    updateTopic(); return true;
  } catch { if (!quiet || !topics.length) $('load-error').hidden = false; return false; }
  finally { loading = false; $('retry').disabled = false; controls(); }
}
async function loadPdfDetails() {
  const topic = selectedTopic(); if (!publisher.connected || !topic || busy || pending) return;
  const sequence = ++pdfSequence;
  pdfLoading = true; pdfDetails = null; $('pdf-confirmation').hidden = true; $('pdf-link').hidden = true; $('retry-pdf').hidden = true;
  $('pdf-status').className = ''; $('pdf-status').textContent = 'Checking this topic’s PDF…'; controls();
  try {
    const details = await publisher.getNotePdf({ topic: topic.id });
    if (sequence !== pdfSequence || !publisher.connected || topic.id !== selectedTopic()?.id) return;
    pdfDetails = details;
    const path = safeAsset(details.pdfUrl, PDF_PATH);
    if (!details.pdfUrl) $('pdf-status').textContent = 'This topic has no PDF attachment.';
    else if (!path || !details.managed) { pdfDetails = null; $('pdf-status').textContent = 'This PDF uses a location that cannot be managed here. Edit its link in the website content.'; }
    else {
      $('pdf-link').href = path; $('pdf-link').hidden = !details.exists;
      if (!details.exists) $('pdf-status').textContent = 'The PDF attachment points to a file that is missing from the repository. Reload the details or correct its link in the website content.';
      else if (details.sharedBy?.length) $('pdf-status').textContent = `This PDF is also used by ${details.sharedBy.join(', ')}. It cannot be deleted here while those references remain.`;
      else $('pdf-status').textContent = `Attached PDF: ${path.split('/').at(-1)}`;
    }
  } catch (error) {
    if (sequence !== pdfSequence) return;
    pdfDetails = null; $('pdf-status').className = 'error'; $('pdf-status').textContent = error.message; $('retry-pdf').hidden = false;
  } finally { if (sequence === pdfSequence) { pdfLoading = false; controls(); } }
}
async function loadProfile() {
  const sequence = ++profileSequence; photoLoading = true; $('retry-photo').hidden = true; controls();
  try {
    const value = await publicJson('./content/profile.json');
    if (sequence !== profileSequence) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid profile');
    profile = value;
    const path = safeAsset(profile.photoUrl, /^assets\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:jpg|jpeg|png|webp)$/i);
    $('current-photo').hidden = !path; $('photo-placeholder').hidden = !!path;
    $('photo-placeholder').textContent = profile.photoUrl && !path ? 'The current photo uses an unsupported location.' : 'Your homepage currently uses the geometric illustration.';
    if (path) { $('current-photo').src = path; $('current-photo').alt = profile.photoAlt || 'Current profile photo'; }
    else $('current-photo').removeAttribute('src');
    if (!photoBytes && !photoPreparing) $('photo-alt').value = profile.photoAlt || '';
    if (!photoBytes && !photoPreparing) $('photo-status').textContent = '';
  } catch {
    if (sequence !== profileSequence) return;
    profile = null; $('photo-status').className = 'error'; $('photo-status').textContent = 'The current photo details could not be loaded. Please reload them before publishing a photo.'; $('retry-photo').hidden = false;
  } finally { if (sequence === profileSequence) { photoLoading = false; controls(); } }
}
$('current-photo').addEventListener('error', () => { $('current-photo').hidden = true; $('photo-placeholder').hidden = false; $('photo-placeholder').textContent = 'The current photo could not be displayed.'; });

function keepPendingInURL() {
  const url = new URL(location.href);
  for (const key of ['publication', 'source', 'upload-topic', 'change-kind', 'photo', 'photo-alt', 'removed-pdf']) url.searchParams.delete(key);
  if (pending) {
    url.searchParams.set('publication', pending.commit);
    url.searchParams.set('change-kind', pending.kind || 'zip');
    if (pending.topic) url.searchParams.set('upload-topic', pending.topic);
    if (pending.sourceSha256) url.searchParams.set('source', pending.sourceSha256);
    if (pending.kind === 'profile-photo') { url.searchParams.set('photo', pending.photoUrl || ''); url.searchParams.set('photo-alt', pending.photoAlt || ''); }
    if (pending.kind === 'delete-pdf') url.searchParams.set('removed-pdf', pending.removedPdfUrl || '');
  }
  history.replaceState(null, '', url);
}
function publicationExtras(run) {
  const href = run?.id && /^\d+$/.test(String(run.id)) ? `${REPO_URL}/actions/runs/${run.id}` : `${REPO_URL}/actions`;
  return [link('View build details', href, true)];
}
async function deployedCommitIncludes(commit) {
  const deployment = await publicJson('./deployment.json');
  if (!SHA.test(deployment.commit || '')) return false;
  if (deployment.commit === commit) return true;
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/compare/${commit}...${deployment.commit}`, { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000), headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) return false;
  const comparison = await response.json();
  return comparison.status === 'ahead' || comparison.status === 'identical';
}
async function publicChangeMatches(current, topic, topicsFresh) {
  if (!current.kind || current.kind === 'zip') return topicsFresh && validWebNote(topic) && topic.sourceSha256 === current.sourceSha256;
  if (!await deployedCommitIncludes(current.commit)) return false;
  if (current.kind === 'profile-photo') {
    const published = await publicJson('./content/profile.json');
    return (published.photoUrl || '') === current.photoUrl && (published.photoAlt || '') === current.photoAlt;
  }
  if (current.kind === 'delete-pdf') {
    if (!topicsFresh || !topic || topic.pdfUrl || !safeAsset(current.removedPdfUrl, PDF_PATH)) return false;
    const response = await fetch(`${current.removedPdfUrl}?publication=${current.commit}`, { method: 'HEAD', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(20000) });
    return response.status === 404;
  }
  return false;
}
async function checkPublication() {
  clearTimeout(timer);
  if (!pending || monitoring) return;
  monitoring = true; controls(); const current = pending;
  try {
    const topicsFresh = await loadTopics(true);
    if (pending !== current) return;
    const topic = topics.find(item => item.id === current.topic);
    let matches = false;
    try { matches = await publicChangeMatches(current, topic, topicsFresh); } catch { /* A failed read cannot confirm publication. */ }
    if (pending !== current) return;
    if (matches) {
      const message = current.kind === 'profile-photo' ? current.photoUrl ? 'Your new profile photo is now on the homepage.' : 'Your profile photo was removed. The geometric illustration is now on the homepage.' : current.kind === 'delete-pdf' ? `The PDF for ${topic.title} has been removed from the public homepage.` : `Published: ${topic.title} is now on your homepage.`;
      const extras = !current.kind || current.kind === 'zip' ? [link('Read the published note', topic.webUrl), node('span', ' · '), link('Open the homepage', './#notes')] : [link('Open the homepage', current.kind === 'profile-photo' ? './#about' : './#notes')];
      status(message, false, extras);
      pending = null; keepPendingInURL(); closeConfirmations(); updateTopic();
      if (publisher.connected) await loadProfile();
      return;
    }
    let run; try { run = await publicationRun(current.commit); } catch { /* Public metadata can still confirm publication. */ }
    if (run?.status === 'completed' && !['success', 'cancelled', 'skipped'].includes(run.conclusion)) {
      status(`The change was saved, but the website build or publication failed${run.conclusion ? ` (${run.conclusion})` : ''}. The previous homepage remains online. Check the build details before making another change.`, true, publicationExtras(run));
      pending = null; keepPendingInURL(); return;
    }
    status(run?.conclusion === 'success' ? 'Build complete. Waiting for the updated content to reach the public homepage…' : ['cancelled', 'skipped'].includes(run?.conclusion) ? 'A newer update may have replaced this build. Checking whether your change is present on the public homepage…' : 'Change saved. Building and publishing your homepage…', false, publicationExtras(run));
    if (++watchCount < 60) timer = setTimeout(checkPublication, 15000);
    else status('Publication is still pending. Use Check for updates later. A saved change is not yet confirmation that the public homepage has updated.', false, publicationExtras(run));
  } finally { monitoring = false; controls(); }
}
async function performChange(action, kind, metadata = {}) {
  if (!publisher.connected || locked()) return;
  busy = true; controls();
  try {
    const result = await action();
    pending = { ...result, ...metadata, kind: kind || result.kind || 'zip' };
    watchCount = 0; keepPendingInURL(); closeConfirmations(); status('Change saved. Homepage publication is starting…');
    if (kind === 'profile-photo') clearPhotoSelection();
  } catch (error) {
    status(error.message, true);
    if (!publisher.connected) { $('connection-summary').textContent = 'Connect your publishing account'; $('connection-status').textContent = 'Please reconnect publishing.'; }
  } finally { busy = false; controls(); }
  if (pending) await checkPublication();
}

$('connection-form').addEventListener('submit', async event => {
  event.preventDefault(); if (connecting || busy) return;
  connecting = true; const token = $('publishing-token').value; $('publishing-token').value = '';
  $('connection-status').className = ''; $('connection-status').textContent = 'Connecting to your publishing account…'; controls();
  try {
    const account = await publisher.connect(token);
    $('connection-status').className = 'success'; $('connection-status').textContent = `Connected as ${account.login} for this open tab.`;
    $('connection-summary').textContent = 'Publishing account connected';
    try { sessionStorage.setItem('research-owner-ui', JSON.stringify({ login: 'Hestious', verifiedAt: Date.now() })); window.dispatchEvent(new Event('research-owner-ui-change')); } catch { /* UI marker is optional and carries no credential. */ }
    await Promise.all([loadPdfDetails(), loadProfile()]);
  } catch (error) { $('connection-status').className = 'error'; $('connection-status').textContent = error.message; }
  finally { connecting = false; controls(); }
});
$('disconnect').addEventListener('click', () => {
  publisher.disconnect(); pdfSequence++; profileSequence++; pdfLoading = false; photoLoading = false; pdfDetails = null;
  clearPhotoSelection(); closeConfirmations();
  try { sessionStorage.removeItem('research-owner-ui'); window.dispatchEvent(new Event('research-owner-ui-change')); } catch {}
  $('publishing-token').value = ''; $('connection-status').textContent = 'Disconnected. The publishing token has been cleared.'; $('connection-status').className = ''; $('connection-summary').textContent = 'Connect your publishing account'; controls();
});
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
$('publish').addEventListener('click', () => {
  const topic = selectedTopic(); if (!topic || !fileBytes || loading) return;
  performChange(() => publisher.publish({ topic: topic.id, title: topic.title, bytes: fileBytes, filename: fileName, onProgress: message => status(message) }), 'zip');
});
$('delete-pdf').addEventListener('click', () => {
  if ($('delete-pdf').disabled || !pdfDetails) return;
  $('pdf-confirmation-text').textContent = `Delete ${pdfDetails.pdfUrl.split('/').at(-1)} from ${pdfDetails.title}?${pdfDetails.hasOtherContent ? ' The topic’s other notes will stay available.' : ' This topic will return to In preparation until another note is published.'}`;
  $('pdf-confirmation').hidden = false; $('confirm-delete-pdf').focus();
});
$('cancel-delete-pdf').addEventListener('click', () => { $('pdf-confirmation').hidden = true; $('delete-pdf').focus(); });
$('confirm-delete-pdf').addEventListener('click', () => {
  if ($('confirm-delete-pdf').disabled || $('pdf-confirmation').hidden || !pdfDetails) return;
  const current = { ...pdfDetails };
  performChange(() => publisher.deleteNotePdf({ topic: current.topic, expectedPdfUrl: current.pdfUrl, expectedPdfSha: current.pdfSha, onProgress: message => status(message) }), 'delete-pdf', { topic: current.topic, removedPdfUrl: current.pdfUrl });
});
$('retry-pdf').addEventListener('click', loadPdfDetails);
$('photo-file').addEventListener('change', async () => {
  const file = $('photo-file').files?.[0];
  clearPhotoSelection({ clearInput: false });
  if (!file) { $('photo-status').textContent = ''; controls(); return; }
  const sequence = photoSequence; photoPreparing = true; $('photo-status').className = ''; $('photo-status').textContent = 'Preparing your photo preview…'; controls();
  let originalURL = '', preparedURL = '';
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('Choose a photo no larger than 5 MB.');
    const input = new Uint8Array(await file.arrayBuffer()); const format = validatePhoto(input, file.name);
    originalURL = URL.createObjectURL(new Blob([input], { type: format.mimeType }));
    const image = new Image(); image.src = originalURL; await image.decode();
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40000000) throw new Error('Choose a photo with no more than 40 million pixels.');
    const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d'); if (!context) throw new Error('This browser could not prepare the photo.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const prepared = await new Promise(resolve => canvas.toBlob(resolve, format.mimeType, .92));
    if (!prepared) throw new Error('This browser could not prepare the photo.');
    const extension = prepared.type === 'image/png' ? 'png' : prepared.type === 'image/webp' ? 'webp' : 'jpg';
    const bytes = new Uint8Array(await prepared.arrayBuffer()); const filename = `profile.${extension}`; validatePhoto(bytes, filename);
    if (sequence !== photoSequence || !publisher.connected) return;
    preparedURL = URL.createObjectURL(prepared); photoObjectURL = preparedURL; preparedURL = '';
    photoBytes = bytes; photoName = filename;
    $('photo-preview').src = photoObjectURL; $('photo-preview-wrap').hidden = false;
    $('photo-status').textContent = `${file.name} · preview ready. Click Publish photo to update your homepage.`;
  } catch (error) { if (sequence === photoSequence) { $('photo-status').className = 'error'; $('photo-status').textContent = error.message || 'This image could not be read. Choose a JPG, PNG, or WebP photo.'; } }
  finally { if (originalURL) URL.revokeObjectURL(originalURL); if (preparedURL) URL.revokeObjectURL(preparedURL); if (sequence === photoSequence) { photoPreparing = false; controls(); } }
});
$('publish-photo').addEventListener('click', () => {
  if (!photoBytes || $('publish-photo').disabled) return;
  const bytes = photoBytes, filename = photoName, alt = $('photo-alt').value.trim() || 'Profile photo';
  performChange(() => publisher.updateProfilePhoto({ bytes, filename, alt, onProgress: message => status(message) }), 'profile-photo');
});
$('remove-photo').addEventListener('click', () => { if (!$('remove-photo').disabled) { $('photo-confirmation').hidden = false; $('confirm-remove-photo').focus(); } });
$('cancel-remove-photo').addEventListener('click', () => { $('photo-confirmation').hidden = true; $('remove-photo').focus(); });
$('confirm-remove-photo').addEventListener('click', () => {
  if ($('confirm-remove-photo').disabled || $('photo-confirmation').hidden) return;
  const expectedPhotoUrl = profile.photoUrl;
  performChange(() => publisher.removeProfilePhoto({ expectedPhotoUrl, onProgress: message => status(message) }), 'profile-photo');
});
$('retry-photo').addEventListener('click', loadProfile);
$('topic').addEventListener('change', updateTopic);
$('retry').addEventListener('click', () => loadTopics());
$('check-updates').addEventListener('click', async () => { if (pending) { watchCount = 0; await checkPublication(); } else { await loadTopics(); if (publisher.connected) await loadProfile(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden && !busy) { if (pending) checkPublication(); else loadTopics(true); } });
window.addEventListener('pagehide', () => { publisher.disconnect(); clearPhotoSelection(); pdfSequence++; profileSequence++; });
window.addEventListener('pageshow', () => { if (!publisher.connected) { $('connection-summary').textContent = 'Connect your publishing account'; $('connection-status').textContent = ''; pdfLoading = false; photoLoading = false; closeConfirmations(); } controls(); });
const query = new URL(location.href).searchParams;
if (SHA.test(query.get('publication') || '')) {
  const commit = query.get('publication'), kind = query.get('change-kind') || 'zip', topic = query.get('upload-topic');
  if (kind === 'zip' && /^[a-f0-9]{64}$/.test(query.get('source') || '') && TOPIC.test(topic || '')) pending = { commit, kind, topic, sourceSha256: query.get('source') };
  if (kind === 'profile-photo' && query.has('photo') && (!query.get('photo') || safeAsset(query.get('photo'), PHOTO_PATH))) pending = { commit, kind, photoUrl: query.get('photo'), photoAlt: (query.get('photo-alt') || '').slice(0, 300) };
  if (kind === 'delete-pdf' && TOPIC.test(topic || '') && safeAsset(query.get('removed-pdf'), PDF_PATH)) pending = { commit, kind, topic, removedPdfUrl: query.get('removed-pdf') };
}
await loadTopics();
if (pending) checkPublication();
