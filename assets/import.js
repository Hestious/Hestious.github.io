const topicSelect = document.getElementById('topic');
const uploadLink = document.getElementById('upload-link');
const folderLink = document.getElementById('folder-link');
const currentNote = document.getElementById('current-note');
const errorBox = document.getElementById('load-error');
const retry = document.getElementById('retry');
const repository = 'https://github.com/Hestious/Hestious.github.io';
let topics = [];

function updateTopic() {
  const topic = topics.find(item => item.id === topicSelect.value);
  if (!topic) return;
  const folder = `sources/${encodeURIComponent(topic.id)}`;
  uploadLink.href = `${repository}/upload/main/${folder}`;
  uploadLink.removeAttribute('aria-disabled');
  uploadLink.removeAttribute('tabindex');
  uploadLink.setAttribute('aria-label', `Upload ZIP for ${topic.title} on GitHub`);
  folderLink.href = `${repository}/tree/main/${folder}`;
  folderLink.hidden = false;
  document.getElementById('topic-description').textContent = topic.description || '';
  currentNote.replaceChildren();
  if (topic.webUrl === `notes/imported/${topic.id}/index.html`) {
    const link = document.createElement('a');
    link.href = topic.webUrl;
    link.textContent = `Read the current web note: ${topic.title}`;
    currentNote.append(link);
  } else {
    currentNote.textContent = 'No converted web note has been published for this topic yet.';
  }
  const url = new URL(window.location.href);
  url.searchParams.set('topic', topic.id);
  history.replaceState(null, '', url);
}

async function loadTopics() {
  errorBox.hidden = true;
  retry.disabled = true;
  topicSelect.disabled = true;
  try {
    const response = await fetch('./content/notes.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error('Topics unavailable');
    const notes = await response.json();
    if (!Array.isArray(notes)) throw new Error('Invalid topics');
    topics = notes.filter(note => note && /^[a-z0-9][a-z0-9-]*$/.test(note.id) && typeof note.title === 'string' && note.status !== 'draft');
    if (!topics.length) throw new Error('No topics');
    topicSelect.replaceChildren(...topics.map(topic => {
      const option = document.createElement('option');
      option.value = topic.id;
      option.textContent = topic.title;
      return option;
    }));
    const requested = new URL(window.location.href).searchParams.get('topic');
    if (topics.some(topic => topic.id === requested)) topicSelect.value = requested;
    topicSelect.disabled = false;
    updateTopic();
  } catch {
    errorBox.hidden = false;
    uploadLink.removeAttribute('href');
    uploadLink.setAttribute('aria-disabled', 'true');
    uploadLink.setAttribute('tabindex', '-1');
    folderLink.hidden = true;
    topicSelect.replaceChildren(new Option('Topics unavailable', ''));
  } finally {
    retry.disabled = false;
  }
}

topicSelect.addEventListener('change', updateTopic);
retry.addEventListener('click', loadTopics);
loadTopics();
