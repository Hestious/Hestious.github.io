const $ = (id) => document.getElementById(id);
const data = { profile: {}, interests: [], publications: [], notes: [] };
let category = 'All topics';
let search = '';
let contentLoaded = false;
let contentLoading = false;
let lastContentCheck = 0;
let readController;
let previousFocus;
let noteSequence = 0;
let photoSequence = 0;
let photoRequest;
const githubBase = 'https://github.com/Hestious/Hestious.github.io/edit/main/';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function append(parent, ...nodes) { parent.append(...nodes.filter(Boolean)); return parent; }
function icon(kind = 'book') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('fill','none'); svg.setAttribute('stroke','currentColor'); svg.setAttribute('stroke-width','1.4'); svg.setAttribute('aria-hidden','true'); svg.classList.add('rh-icon');
  const paths = { book: 'M3 4c4-1 6 0 9 2 3-2 5-3 9-2v15c-4-1-6 0-9 2-3-2-5-3-9-2V4Zm9 2v15', file: 'M5 3h9l5 5v13H5V3Zm9 0v5h5M8 12h8M8 16h8', orbit: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-9 6 18 8M3 16 21 8M12 2v20', network: 'M9 3h6v5H9V3Zm-7 14h6v5H2v-5Zm14 0h6v5h-6v-5ZM12 8v5M5 17v-4h14v4', layers: 'm12 2 10 5-10 5L2 7l10-5ZM2 12l10 5 10-5M2 17l10 5 10-5', plus: 'M12 5v14M5 12h14', mail: 'M3 5h18v14H3V5Zm0 0 9 8 9-8' };
  const path = document.createElementNS('http://www.w3.org/2000/svg','path'); path.setAttribute('d',paths[kind] || paths.book); svg.append(path); return svg;
}
export function safeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const raw = value.trim();
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return '';
  try {
    if (/^https?:\/\//i.test(raw)) { const parsed = new URL(raw); return parsed.username || parsed.password ? '' : parsed.href; }
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return '';
    const decoded = decodeURIComponent(raw);
    if (decoded.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(decoded) || decoded.split(/[/?#]/).includes('..') || /^\/?api\//.test(decoded)) return '';
    const parsed = new URL(raw, document.baseURI);
    return parsed.origin === window.location.origin ? parsed.href : '';
  } catch { return ''; }
}
export function profilePhotoUrl(value) {
  // Only the local, content-addressed files created by the owner photo control.
  return typeof value==='string' && /^assets\/profile\/photo-[a-f0-9]{64}\.(?:png|jpg|webp)$/.test(value)
    ? safeUrl(value) : '';
}
export function renderProfilePhoto(profile) {
  const container=$('profile-visual');const image=$('profile-photo');const fallback=$('profile-photo-fallback');
  if(!container||!image||!fallback)return;
  const sequence=++photoSequence;const url=profilePhotoUrl(profile.photoUrl);
  if(photoRequest){photoRequest.onload=null;photoRequest.onerror=null;photoRequest=null;}
  const showFallback=(state)=>{image.hidden=true;image.removeAttribute('src');fallback.hidden=false;container.dataset.photoState=state;};
  container.classList.toggle('rh-photo-enabled',!!url);
  if(!url){image.alt='';showFallback('empty');return;}
  const name=typeof profile.name==='string'?profile.name.trim():'';
  image.alt=typeof profile.photoAlt==='string'&&profile.photoAlt.trim()
    ? profile.photoAlt.trim() : (name&&name!=='Research & notes'?`Portrait of ${name}`:'Profile photograph');
  if(image.src===url&&image.complete&&image.naturalWidth>0){image.hidden=false;fallback.hidden=true;container.dataset.photoState='ready';return;}
  container.dataset.photoState='loading';
  const request=new Image();photoRequest=request;request.decoding='async';
  request.onload=()=>{
    if(sequence!==photoSequence)return;
    image.src=url;image.hidden=false;fallback.hidden=true;container.dataset.photoState='ready';photoRequest=null;
  };
  request.onerror=()=>{
    if(sequence!==photoSequence)return;
    showFallback('error');photoRequest=null;
  };
  request.src=url;
}
function resourceLink(label, value, className = '') {
  const url = safeUrl(value); if (!url) return null;
  const node = element('a', className, label); node.href = url; node.target = '_blank'; node.rel = 'noopener noreferrer'; return node;
}
function badge(note) { return element('span', `rh-badge ${note.status === 'available' ? 'rh-badge-available' : ''}`,note.status === 'available' ? 'Available' : 'In preparation'); }
function renderProfile() {
  const p=data.profile; const name=p.name || 'Research & notes';
  renderProfilePhoto(p);
  $('brand-initial').textContent = name.trim().slice(0,1).toUpperCase(); $('brand-name').textContent=name; $('footer-name').textContent=name;
  document.querySelector('.rh-brand').setAttribute('aria-label',`${name} homepage`);
  $('profile-title').replaceChildren(document.createTextNode(name));
  if(name.toLowerCase()!=='research & notes') $('profile-title').append(element('span','', 'Research & notes'));
  $('profile-role').replaceChildren(document.createTextNode(p.role || ''));
  if(p.affiliation) append($('profile-role'),element('span','rh-separator','/'),document.createTextNode(p.affiliation));
  $('profile-bio').textContent=p.bio || '';
  const links=$('profile-links');links.replaceChildren();
  if(p.email && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(p.email)) { const mail=element('a');mail.href=`mailto:${encodeURIComponent(p.email).replace('%40','@')}`;append(mail,icon('mail'),document.createTextNode('Get in touch'));links.append(mail); }
  (p.links || []).forEach(link=>{const node=resourceLink(link.label,link.url);if(node)links.append(node);});
  if(p.location)links.append(element('span','',p.location));
  document.title=name.toLowerCase()==='research & notes'?'Research & Notes':`${name} | Research & Notes`;
}
function renderInterests() {
  const list=$('research-list');list.replaceChildren();
  data.interests.forEach((interest,index)=>{
    const article=element('article','rh-interest');const symbol=append(element('div','rh-interest-icon'),icon(['network','orbit','layers'][index%3]));
    const text=append(element('div'),element('h3','',interest.title),element('p','',interest.description));
    const tags=element('div','rh-tags');(interest.tags||[]).filter(Boolean).forEach(tag=>tags.append(element('span','',tag)));text.append(tags);append(article,symbol,text);list.append(article);
  });
  if(!data.interests.length)list.append(element('p','rh-reader-description','Research interests will be added here.'));
}
function renderPublications() {
  const list=$('publication-list');list.replaceChildren();
  if(!data.publications.length){list.append(append(element('div','rh-publications-empty'),icon('file'),append(element('div'),element('h3','','Publication list forthcoming'),element('p','','Papers and preprints will be listed here as they are added.'))));return;}
  data.publications.forEach(p=>{
    const article=element('article','rh-publication');const text=element('div');const title=element('h3');title.append(resourceLink(p.title,p.url)||document.createTextNode(p.title));
    append(text,title,element('p','rh-authors',p.authors));if(p.venue)text.append(element('p','rh-venue',p.venue));
    const links=element('div','rh-paper-links');
    if(p.abstract){const abstract=element('p','rh-abstract',p.abstract);abstract.hidden=true;const button=element('button','','+ Abstract');button.type='button';button.setAttribute('aria-expanded','false');button.addEventListener('click',()=>{abstract.hidden=!abstract.hidden;button.textContent=abstract.hidden?'+ Abstract':'− Abstract';button.setAttribute('aria-expanded',String(!abstract.hidden));});links.append(button);text.append(links,abstract);}
    else text.append(links);
    append(links,resourceLink('Paper',p.url),resourceLink('PDF',p.pdfUrl));append(article,element('div','rh-publication-year',p.year),text);list.append(article);
  });
}
function renderFilters() {
  const filters=$('note-filters');filters.replaceChildren();
  ['All topics',...new Set(data.notes.map(n=>n.category).filter(Boolean))].forEach(label=>{const button=element('button',label===category?'rh-filter-active':'',label);button.type='button';button.setAttribute('aria-pressed',String(label===category));button.addEventListener('click',()=>{category=label;renderFilters();renderNotes();$('note-filters').querySelector('[aria-pressed="true"]')?.focus();});filters.append(button);});
}
function renderNotes() {
  const notes=data.notes.filter(note=>(category==='All topics'||category===note.category)&&`${note.title} ${note.description} ${note.category}`.toLowerCase().includes(search.toLowerCase().trim()));
  const list=$('note-list');list.replaceChildren();$('clear-search').hidden=!search;
  $('note-count').textContent=`${data.notes.length} topics`;
  notes.forEach(note=>{
    const webUrl=safeUrl(note.webUrl);
    const link=element('a','rh-note-row');link.href=webUrl||`?note=${encodeURIComponent(note.id)}#notes`;link.dataset.noteId=note.id;
    const text=append(element('div','rh-note-info'),element('div','rh-note-category',note.category),element('h3','',note.title),element('p','',note.description));
    const mark=badge(note);if(note.status==='available')mark.textContent=webUrl?'Read online':'Read notes';const plus=icon('plus');plus.classList.add('rh-note-open');
    append(link,append(element('div','rh-note-symbol'),icon()),text,mark,plus);
    if(!webUrl)link.addEventListener('click',event=>{if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||event.button!==0)return;event.preventDefault();previousFocus=link;const url=new URL(window.location.href);url.searchParams.set('note',note.id);history.pushState({researchNoteOpened:true},'',url);syncNote();});list.append(link);
  });
  if(!notes.length){const empty=append(element('div','rh-search-empty'),element('h3','','No matching notes'),element('p','','Try another keyword or explore all topics.'));const reset=element('button','rh-button rh-button-light','Show all topics');reset.type='button';reset.addEventListener('click',()=>{search='';category='All topics';$('note-search').value='';renderFilters();renderNotes();$('note-search').focus();});append(empty,reset);list.append(empty);}
}

// Markdown is rendered as text nodes: embedded HTML and scripts are never interpreted.
export function renderNoteText(text) {
  const fragment=document.createDocumentFragment();const lines=String(text).replace(/\r\n?/g,'\n').split('\n');let i=0;
  while(i<lines.length){
    const line=lines[i]; if(!line.trim()){i++;continue;}
    if(/^```/.test(line)){const code=[];i++;while(i<lines.length&&!/^```/.test(lines[i]))code.push(lines[i++]);if(i<lines.length)i++;fragment.append(append(element('pre'),element('code','',code.join('\n'))));continue;}
    const heading=line.match(/^(#{1,6})\s+(.+)$/);if(heading){fragment.append(element(heading[1].length<=2?'h3':'h4','',heading[2]));i++;continue;}
    if(/^\s*[-*+]\s+/.test(line)){const list=element('ul');while(i<lines.length&&/^\s*[-*+]\s+/.test(lines[i]))list.append(element('li','',lines[i++].replace(/^\s*[-*+]\s+/,'')));fragment.append(list);continue;}
    if(/^\s*\d+\.\s+/.test(line)){const list=element('ol');while(i<lines.length&&/^\s*\d+\.\s+/.test(lines[i]))list.append(element('li','',lines[i++].replace(/^\s*\d+\.\s+/,'')));fragment.append(list);continue;}
    if(/^>\s?/.test(line)){const quote=[];while(i<lines.length&&/^>\s?/.test(lines[i]))quote.push(lines[i++].replace(/^>\s?/,''));fragment.append(element('blockquote','',quote.join('\n')));continue;}
    const para=[];while(i<lines.length&&lines[i].trim()&&(para.length===0||!/^(```|#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|>)/.test(lines[i])))para.push(lines[i++]);fragment.append(element('p','',para.join('\n')));
  }
  return fragment;
}
function manuscriptEmpty(note) {
  if (safeUrl(note.webUrl)) return append(element('div','rh-manuscript-empty'),icon(),element('h3','','Read this note online'),element('p','','Open the reading page above for selectable text, rendered formulas, figures, and references.'));
  const hasResources=!!(safeUrl(note.pdfUrl)||safeUrl(note.externalUrl));
  return append(element('div','rh-manuscript-empty'),icon(),element('h3','',hasResources?'Explore the attached material':'Notes in preparation'),element('p','',hasResources?'Use the links above to read the material for this topic.':'This topic is part of my notes collection. A manuscript has not been posted yet.'));
}
function validBodyFile(path) { return typeof path==='string' && /^notes\/[a-zA-Z0-9_./-]+\.md$/.test(path) && !path.split('/').includes('..') && !path.includes('//'); }
async function syncNote() {
  if(!contentLoaded)return;
  const id=new URL(window.location.href).searchParams.get('note');const note=data.notes.find(n=>n.id===id);const dialog=$('note-reader');
  noteSequence++;const sequence=noteSequence;readController?.abort();$('note-unavailable').hidden=!id||!!note;
  if(!note){if(dialog.open)dialog.close();if(previousFocus?.isConnected)previousFocus.focus();return;}
  if(!dialog.open){previousFocus=document.activeElement;dialog.showModal();}
  $('reader-category').textContent=note.category;$('note-title').textContent=note.title;$('reader-description').textContent=note.description;
  const meta=$('reader-meta');meta.replaceChildren(badge(note));if(note.updatedAt){const date=new Date(note.updatedAt);if(!Number.isNaN(date.getTime()))meta.append(element('span','',`Updated ${date.toLocaleDateString('en',{year:'numeric',month:'long',day:'numeric',timeZone:'UTC'})}`));}
  const links=$('reader-links');links.replaceChildren();
  const webLink=resourceLink('Read online',note.webUrl,'rh-button');if(webLink){webLink.removeAttribute('target');webLink.removeAttribute('rel');}
  append(links,webLink,resourceLink('Read PDF',note.pdfUrl,webLink?'rh-button rh-button-light':'rh-button'),resourceLink('Open resource',note.externalUrl,'rh-button rh-button-light'));links.hidden=!links.childElementCount;
  const body=$('reader-body');body.className='';body.replaceChildren(element('p','rh-reader-status','Loading note…'));
  $('edit-note').href=safeUrl(note.webUrl)?`./import.html?topic=${encodeURIComponent(note.id)}`:(validBodyFile(note.bodyFile)?githubBase+note.bodyFile:githubBase+'content/notes.json');
  $('edit-note').textContent=safeUrl(note.webUrl)?'Replace LaTeX ZIP':'Edit this note on GitHub';
  try{
    let text=typeof note.body==='string'?note.body:'';
    if(safeUrl(note.webUrl)){body.replaceChildren(manuscriptEmpty(note));return;}
    if(validBodyFile(note.bodyFile)){readController=new AbortController();const response=await fetch(`./${note.bodyFile}`,{signal:readController.signal,cache:'no-cache'});if(!response.ok)throw Error('Note unavailable');text=await response.text();}
    if(sequence!==noteSequence)return;
    // An optional leading HTML comment provides editing instructions, not manuscript text.
    text=text.replace(/^\s*<!--[\s\S]*?-->\s*/,'');
    if(text.trim()){body.className='rh-note-body';body.replaceChildren(renderNoteText(text));}else body.replaceChildren(manuscriptEmpty(note));
  }catch(error){if(error.name==='AbortError'||sequence!==noteSequence)return;body.replaceChildren(element('p','rh-load-error','The note could not be loaded. Please close it and try again.'));}
}
function closeNote(){if(history.state?.researchNoteOpened)history.back();else{const url=new URL(window.location.href);url.searchParams.delete('note');history.replaceState(null,'',url);syncNote();}}
async function loadContent({background=false}={}){
  if(contentLoading)return;
  if(background&&Date.now()-lastContentCheck<5000)return;
  contentLoading=true;
  if(!background){$('main-content').setAttribute('aria-busy','true');$('retry-content').disabled=true;$('load-error').hidden=true;}
  try{
    const [profile,interests,publications,notes]=await Promise.all(['profile','interests','publications','notes'].map(async name=>{const response=await fetch(`./content/${name}.json`,{cache:'no-cache'});if(!response.ok)throw Error('Content unavailable');return response.json();}));
    if(!profile||typeof profile!=='object'||Array.isArray(profile)||![interests,publications,notes].every(Array.isArray))throw Error('Invalid content');
    const next={profile,interests,publications,notes:notes.filter(note=>note.status!=='draft')};
    const changed=Object.fromEntries(Object.keys(next).map(key=>[key,!contentLoaded||JSON.stringify(data[key])!==JSON.stringify(next[key])]));
    const currentId=new URL(window.location.href).searchParams.get('note');
    const previousNote=data.notes.find(note=>note.id===currentId);
    const focusedNoteId=previousFocus?.dataset?.noteId;
    Object.assign(data,next);
    if(changed.profile)renderProfile();if(changed.interests)renderInterests();if(changed.publications)renderPublications();
    if(changed.notes){
      if(category!=='All topics'&&!data.notes.some(note=>note.category===category))category='All topics';
      renderFilters();renderNotes();
      if(focusedNoteId)previousFocus=Array.from($('note-list').querySelectorAll('.rh-note-row')).find(link=>link.dataset.noteId===focusedNoteId);
    }
    contentLoaded=true;
    const currentNote=data.notes.find(note=>note.id===currentId);
    if(!background||(currentId&&(!$('note-reader').open||JSON.stringify(previousNote)!==JSON.stringify(currentNote))))syncNote();
  }catch{ if(!background||!contentLoaded){$('load-error').hidden=false;$('note-count').textContent='Topics unavailable';} }
  finally{contentLoading=false;lastContentCheck=Date.now();if(!background){$('main-content').setAttribute('aria-busy','false');$('retry-content').disabled=false;}}
}
$('retry-content').addEventListener('click',()=>loadContent());
$('note-search').addEventListener('input',event=>{search=event.target.value;renderNotes();});
$('clear-search').addEventListener('click',()=>{search='';$('note-search').value='';renderNotes();$('note-search').focus();});
$('close-note').addEventListener('click',closeNote);$('dismiss-note').addEventListener('click',closeNote);
$('note-reader').addEventListener('cancel',event=>{event.preventDefault();closeNote();});
$('note-reader').addEventListener('click',event=>{if(event.target===event.currentTarget){const rect=event.currentTarget.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeNote();}});
window.addEventListener('popstate',syncNote);
function refreshWhenVisible(){if(document.visibilityState==='visible')loadContent({background:contentLoaded});}
document.addEventListener('visibilitychange',refreshWhenVisible);
window.addEventListener('focus',refreshWhenVisible);
window.addEventListener('pageshow',event=>{if(event.persisted)refreshWhenVisible();});
if('IntersectionObserver' in window){const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting)document.querySelectorAll('.rh-header nav a').forEach(link=>link.classList.toggle('rh-nav-active',link.hash===`#${entry.target.id}`));},{rootMargin:'-15% 0px -65% 0px'});document.querySelectorAll('main section[id]').forEach(section=>observer.observe(section));}
loadContent();
