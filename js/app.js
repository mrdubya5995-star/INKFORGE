// Main application logic: navigation, library rendering, upload, select mode, settings.

// Electron injects its own UA token; used to hide website-only chrome (the
// Download page — an app can't download itself) and website-only fallback
// concerns (Backup & Restore — the desktop build's storage lives in its own
// isolated per-app profile, not a shared browser profile a user might clear).
const IS_ELECTRON = /Electron\//.test(navigator.userAgent);

const SETTINGS_KEY = 'inkforge-settings';
let settings = loadSettings();
let books = [];
let currentView = 'view-home';
let selectMode = false;
let selectedIds = new Set();
let currentDetailBookId = null;
let currentReaderBookId = null;
let loadingShownAt = 0;
let saveTimer = null;

const els = {};
[
  'loading-overlay', 'hero', 'home-actions', 'select-toggle', 'select-toolbar', 'select-count',
  'dropzone', 'file-input', 'search-input', 'search-results', 'library-stats',
  'detail-cover', 'detail-title', 'detail-meta', 'detail-progress', 'detail-favorite', 'detail-start',
  'reader-title', 'reader-progress-fill', 'reader-progress-label', 'finish-btn',
  'orientation-toggle', 'view-reader'
].forEach(id => { els[id] = document.getElementById(id); });

function loadSettings() {
  try {
    return Object.assign({ defaultOrientation: 'horizontal', defaultTheme: 'light' },
      JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
  } catch (e) {
    return { defaultOrientation: 'horizontal', defaultTheme: 'light' };
  }
}
function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }

function showLoading() {
  loadingShownAt = Date.now();
  els['loading-overlay'].hidden = false;
}
async function hideLoading(minMs = 350) {
  const elapsed = Date.now() - loadingShownAt;
  if (elapsed < minMs) await new Promise(r => setTimeout(r, minMs - elapsed));
  els['loading-overlay'].hidden = true;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : str;
  return div.innerHTML;
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '';
  const lines = [];
  for (const w of words) {
    const test = line + w + ' ';
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w + ' '; }
    else line = test;
  }
  lines.push(line);
  const startY = y - (lines.length - 1) * lineHeight / 2;
  lines.forEach((l, i) => ctx.fillText(l.trim(), x, startY + i * lineHeight));
}

function placeholderCover(title, format) {
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 452;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 320, 452);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(1, '#ffe3e3');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 320, 452);
  ctx.strokeStyle = '#e50914';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, 314, 446);
  ctx.fillStyle = '#e50914';
  ctx.font = '700 16px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(format.toUpperCase(), 160, 60);
  ctx.fillStyle = '#141414';
  ctx.font = '700 22px sans-serif';
  wrapText(ctx, title, 160, 220, 260, 30);
  return canvas.toDataURL('image/png');
}

async function getPdfCover(arrayBuffer) {
  try {
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = 500 / base.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch (e) {
    console.error('PDF cover generation failed', e);
    return null;
  }
}

async function getEpubCover(epubBookInstance) {
  try {
    const url = await epubBookInstance.coverUrl();
    if (!url) return null;
    const resp = await fetch(url);
    const blob = await resp.blob();
    return await blobToDataURL(blob);
  } catch (e) {
    console.error('EPUB cover generation failed', e);
    return null;
  }
}

// ---------------- Sidebar hover-expand ----------------
// Deliberately NOT plain `.sidebar:hover` in CSS: that would make the sidebar
// itself grow to 240px on hover, which keeps it "hovered" (and therefore
// expanded, and therefore covering page content underneath, since it's a
// fixed, high z-index element) all the way out to x=240 — swallowing clicks
// on anything real that starts within that band, e.g. the Settings page's
// buttons. Tracking raw cursor x instead means the sidebar only stays
// expanded while the cursor is within its permanent 72px collapsed footprint,
// so moving toward page content beyond that always collapses it immediately,
// regardless of how wide it had grown. Every sidebar item is still fully
// clickable within that same 72px band (icons never move), so nothing is
// lost by not also treating the revealed label text as a hover-sustaining
// zone.
(function setupSidebarHoverExpand() {
  const sidebarEl = document.getElementById('sidebar');
  const collapsedWidth = 72;
  document.addEventListener('mousemove', (e) => {
    sidebarEl.classList.toggle('sidebar-expanded', e.clientX <= collapsedWidth);
  });
  document.addEventListener('mouseleave', () => sidebarEl.classList.remove('sidebar-expanded'));
})();

// ---------------- View switching ----------------
function switchView(viewId) {
  // Reading a book (or favoriting/deleting from its detail page) updates the
  // DB but not the in-memory `books` cache the home view was rendered from.
  // Every path back to home funnels through here, so refreshing on entry
  // (rather than patching each caller) guarantees the hero/shelves never show
  // stale progress, lastOpened, or favorite state.
  const enteringHome = viewId === 'view-home' && currentView !== 'view-home';
  ['view-home', 'view-detail', 'view-reader', 'view-search', 'view-settings', 'view-download', 'view-section-all'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.hidden = (id !== viewId);
  });
  currentView = viewId;
  els['home-actions'].style.display = (viewId === 'view-home') ? '' : 'none';
  if (viewId !== 'view-home' && selectMode) exitSelectMode();
  if (enteringHome) refreshBooks();
}

function scrollToSection(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.querySelectorAll('.sidebar-item[data-section]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const sectionId = btn.dataset.section;
    if (currentView !== 'view-home') {
      showLoading();
      switchView('view-home');
      await new Promise(r => requestAnimationFrame(r));
      scrollToSection(sectionId);
      await hideLoading();
    } else {
      scrollToSection(sectionId);
    }
  });
});

document.getElementById('logo-btn').addEventListener('click', async () => {
  if (currentView === 'view-settings' || currentView === 'view-search' || currentView === 'view-download') {
    showLoading();
    switchView('view-home');
    await hideLoading();
  } else if (currentView !== 'view-home') {
    switchView('view-home');
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

document.getElementById('nav-search').addEventListener('click', async () => {
  showLoading();
  switchView('view-search');
  els['search-input'].value = '';
  els['search-results'].innerHTML = '';
  await hideLoading();
  els['search-input'].focus();
});

document.getElementById('nav-settings').addEventListener('click', async () => {
  showLoading();
  updateLibraryStats();
  switchView('view-settings');
  await hideLoading();
});

document.getElementById('download-toggle').addEventListener('click', async () => {
  showLoading();
  switchView('view-download');
  await hideLoading();
});

document.querySelectorAll('[data-back]').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.back;
    if (target === 'view-detail') {
      flushProgressSave();
      InkReader.close();
      if (currentReaderBookId) openDetail(currentReaderBookId);
      else switchView('view-home');
    } else {
      switchView(target);
    }
  });
});

// ---------------- Library rendering ----------------
async function refreshBooks() {
  books = await InkDB.getAllBooks();
  renderHero();
  renderShelves();
  updateLibraryStats();
}

function renderHero() {
  const heroEl = els['hero'];
  heroEl.innerHTML = '';
  if (books.length === 0) {
    heroEl.innerHTML = `
      <div class="hero-empty-upload" id="hero-upload-cta">
        <svg class="icon"><use href="#icon-upload"/></svg>
        <span>Upload your first ebook to get started</span>
      </div>`;
    document.getElementById('hero-upload-cta').addEventListener('click', () => els['file-input'].click());
    return;
  }
  let heroBook = [...books].filter(b => b.lastOpened).sort((a, b) => b.lastOpened - a.lastOpened)[0];
  let eyebrow = 'Pick up where you left off...';
  let heroButtonLabel = 'Continue Reading';
  if (!heroBook) {
    heroBook = books[Math.floor(Math.random() * books.length)];
    eyebrow = 'Ready to start reading?';
    heroButtonLabel = 'Start Reading';
  }
  const metaBits = [heroBook.format.toUpperCase()];
  if (heroBook.progress > 0 && !heroBook.finished) metaBits.push(Math.round(heroBook.progress * 100) + '% read');
  if (heroBook.finished) metaBits.push('Finished');
  heroEl.innerHTML = `
    <img class="hero-cover" src="${heroBook.coverImage}" alt="">
    <div class="hero-info">
      <p class="hero-eyebrow">${eyebrow}</p>
      <h1 class="hero-title">${escapeHtml(heroBook.title)}</h1>
      <p class="hero-meta">${metaBits.join(' &middot; ')}</p>
      <button class="btn btn-primary" id="hero-start-btn">${heroButtonLabel}</button>
    </div>`;
  document.getElementById('hero-start-btn').addEventListener('click', () => startReading(heroBook.id));
}

// Organization: titles are compared letter-run by letter-run and
// number-run by number-run, in order, rather than as plain strings — so
// "A0" < "A1" < "B0" (A before B beats 0 vs 1), and critically so a run
// like "Ch.9" sorts before "Ch.10" (9 < 10 as numbers, not as the strings
// "9" > "1..."). This is what plain localeCompare / naive alphabetical
// sort gets wrong for anything with chapter/volume numbers in the title.
function naturalCompare(a, b) {
  const tokenize = s => String(s).match(/(\d+)|(\D+)/g) || [];
  const aParts = tokenize(a);
  const bParts = tokenize(b);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ap = aParts[i] ?? '';
    const bp = bParts[i] ?? '';
    const aIsNum = /^\d+$/.test(ap);
    const bIsNum = /^\d+$/.test(bp);
    if (aIsNum && bIsNum) {
      const diff = parseInt(ap, 10) - parseInt(bp, 10);
      if (diff !== 0) return diff;
    } else {
      const cmp = ap.localeCompare(bp, undefined, { sensitivity: 'base' });
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}
function byTitle(bks) { return [...bks].sort((a, b) => naturalCompare(a.title, b.title)); }

const SHELF_CAP = 20;
const SECTION_CONFIG = {
  'section-library': { title: 'Full Library', getList: bks => byTitle(bks) },
  'section-recent': { title: 'Recently Uploaded', getList: bks => [...bks].sort((a, b) => b.addedDate - a.addedDate) },
  'section-favorites': { title: 'Favorites', getList: bks => byTitle(bks.filter(b => b.favorite)) },
  'section-finished': { title: 'Finished', getList: bks => byTitle(bks.filter(b => b.finished)) },
  'section-unfinished': { title: 'Unfinished', getList: bks => byTitle(bks.filter(b => !b.finished && b.progress > 0)) }
};

function computeSections() {
  const result = {};
  for (const [id, cfg] of Object.entries(SECTION_CONFIG)) result[id] = cfg.getList(books);
  return result;
}

function renderShelves() {
  const sections = computeSections();
  for (const [id, list] of Object.entries(sections)) {
    const row = document.querySelector(`#${id} .shelf-row`);
    row.innerHTML = '';
    list.slice(0, SHELF_CAP).forEach(book => row.appendChild(createCard(book)));

    const viewAllBtn = document.querySelector(`#${id} .view-all-btn`);
    if (viewAllBtn) viewAllBtn.hidden = list.length <= SHELF_CAP;

    updateShelfScrollbar(id);
  }
}

// ---------------- Shelf scrollbars ----------------
// The native scrollbar on each shelf-row is hidden (see CSS) in favor of this
// always-visible, draggable indicator, so people can see there's more to
// scroll through without hovering/guessing, and can jump around directly.
function updateShelfScrollbar(sectionId) {
  const row = document.querySelector(`#${sectionId} .shelf-row`);
  const track = document.querySelector(`#${sectionId} .shelf-scrollbar`);
  const thumb = track ? track.querySelector('.shelf-scrollbar-thumb') : null;
  if (!row || !track || !thumb) return;
  const overflowing = row.scrollWidth > row.clientWidth + 1;
  track.hidden = !overflowing;
  if (!overflowing) return;
  const thumbWidthPct = Math.max((row.clientWidth / row.scrollWidth) * 100, 6);
  const maxThumbLeftPct = 100 - thumbWidthPct;
  const scrollableDist = row.scrollWidth - row.clientWidth;
  const thumbLeftPct = scrollableDist > 0 ? (row.scrollLeft / scrollableDist) * maxThumbLeftPct : 0;
  thumb.style.width = thumbWidthPct + '%';
  thumb.style.left = thumbLeftPct + '%';
}

function setupShelfScrollbars() {
  Object.keys(SECTION_CONFIG).forEach(id => {
    const row = document.querySelector(`#${id} .shelf-row`);
    const track = document.querySelector(`#${id} .shelf-scrollbar`);
    const thumb = track ? track.querySelector('.shelf-scrollbar-thumb') : null;
    if (!row || !track || !thumb) return;

    row.addEventListener('scroll', () => updateShelfScrollbar(id));

    let dragging = false;
    let dragStartX = 0;
    let dragStartScrollLeft = 0;

    thumb.addEventListener('pointerdown', (e) => {
      dragging = true;
      dragStartX = e.clientX;
      dragStartScrollLeft = row.scrollLeft;
      thumb.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    thumb.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const draggableTrack = Math.max(track.clientWidth - thumb.offsetWidth, 1);
      const scrollableDist = row.scrollWidth - row.clientWidth;
      const deltaScroll = ((e.clientX - dragStartX) / draggableTrack) * scrollableDist;
      row.scrollLeft = Math.max(0, Math.min(scrollableDist, dragStartScrollLeft + deltaScroll));
    });
    thumb.addEventListener('pointerup', () => { dragging = false; });
    thumb.addEventListener('pointercancel', () => { dragging = false; });

    track.addEventListener('click', (e) => {
      if (e.target === thumb) return;
      const rect = track.getBoundingClientRect();
      const scrollableDist = row.scrollWidth - row.clientWidth;
      row.scrollLeft = ((e.clientX - rect.left) / rect.width) * scrollableDist;
    });
  });

  window.addEventListener('resize', () => {
    Object.keys(SECTION_CONFIG).forEach(id => updateShelfScrollbar(id));
  });
}

// ---------------- Section "View All" page ----------------
document.querySelectorAll('.view-all-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const cfg = SECTION_CONFIG[btn.dataset.viewAll];
    if (!cfg) return;
    showLoading();
    const grid = document.getElementById('section-all-grid');
    grid.innerHTML = '';
    cfg.getList(books).forEach(book => grid.appendChild(createCard(book)));
    document.getElementById('section-all-title').textContent = cfg.title;
    switchView('view-section-all');
    await hideLoading();
  });
});

function createCard(book) {
  const card = document.createElement('div');
  card.className = 'card' + (selectedIds.has(book.id) ? ' selected' : '');
  card.dataset.id = book.id;
  const showProgress = book.progress > 0 && !book.finished;
  card.innerHTML = `
    <div class="card-checkbox"><svg class="icon"><use href="#icon-check"/></svg></div>
    <img class="card-cover" src="${book.coverImage}" alt="">
    ${showProgress ? `<div class="card-progress-track"><div class="card-progress-fill" style="width:${Math.round(book.progress * 100)}%"></div></div>` : ''}
    <div class="card-title">${escapeHtml(book.title)}</div>
  `;
  card.addEventListener('click', () => {
    if (selectMode) toggleSelect(book.id, card);
    else openDetail(book.id);
  });
  return card;
}

// ---------------- Select mode ----------------
function exitSelectMode() {
  selectMode = false;
  selectedIds.clear();
  document.body.classList.remove('select-mode');
  els['select-toggle'].classList.remove('active');
  els['select-toolbar'].hidden = true;
  renderShelves();
}

function updateSelectToolbar() {
  els['select-count'].textContent = `${selectedIds.size} selected`;
}

function toggleSelect(id, card) {
  if (selectedIds.has(id)) { selectedIds.delete(id); card.classList.remove('selected'); }
  else { selectedIds.add(id); card.classList.add('selected'); }
  updateSelectToolbar();
}

els['select-toggle'].addEventListener('click', () => {
  selectMode = !selectMode;
  document.body.classList.toggle('select-mode', selectMode);
  els['select-toggle'].classList.toggle('active', selectMode);
  els['select-toolbar'].hidden = !selectMode;
  if (!selectMode) { selectedIds.clear(); renderShelves(); }
  else updateSelectToolbar();
});

document.getElementById('cancel-select-btn').addEventListener('click', exitSelectMode);

document.getElementById('select-all-btn').addEventListener('click', () => {
  books.forEach(b => selectedIds.add(b.id));
  renderShelves();
  updateSelectToolbar();
});

document.getElementById('deselect-all-btn').addEventListener('click', () => {
  selectedIds.clear();
  renderShelves();
  updateSelectToolbar();
});

document.getElementById('favorite-selected-btn').addEventListener('click', async () => {
  if (selectedIds.size === 0) return;
  showLoading();
  await Promise.all([...selectedIds].map(id => InkDB.updateBook(id, { favorite: true })));
  exitSelectMode();
  await refreshBooks();
  await hideLoading();
});

document.getElementById('delete-selected-btn').addEventListener('click', async () => {
  if (selectedIds.size === 0) return;
  if (!confirm(`Delete ${selectedIds.size} selected book(s)? This cannot be undone.`)) return;
  showLoading();
  await InkDB.deleteBooks([...selectedIds]);
  exitSelectMode();
  await refreshBooks();
  await hideLoading();
});

// ---------------- Upload ----------------
async function handleFiles(fileList) {
  const all = Array.from(fileList);
  const files = all.filter(f => /\.(pdf|epub)$/i.test(f.name));
  const rejected = all.length - files.length;
  if (files.length === 0) {
    if (rejected > 0) alert('Only PDF and EPUB files are supported right now.');
    return;
  }
  showLoading();
  for (const file of files) {
    try {
      const format = /\.pdf$/i.test(file.name) ? 'pdf' : 'epub';
      const title = file.name.replace(/\.(pdf|epub)$/i, '');
      let cover = null;
      if (format === 'pdf') {
        cover = await getPdfCover(await file.arrayBuffer());
      } else {
        const tempBook = ePub(await file.arrayBuffer());
        await tempBook.ready;
        cover = await getEpubCover(tempBook);
        tempBook.destroy();
      }
      if (!cover) cover = placeholderCover(title, format);
      await InkDB.addBook({
        title, format, fileBlob: file, coverImage: cover,
        addedDate: Date.now(), lastOpened: null, favorite: false, finished: false,
        progress: 0, currentLocation: null, readingOrientation: null
      });
    } catch (err) {
      console.error('Failed to add book', file.name, err);
    }
  }
  await refreshBooks();
  if (rejected > 0) alert(`${rejected} file(s) were skipped — only PDF and EPUB are supported right now.`);
  await hideLoading();
  els['file-input'].value = '';
}

els['dropzone'].addEventListener('click', () => els['file-input'].click());
els['file-input'].addEventListener('change', (e) => handleFiles(e.target.files));
['dragenter', 'dragover'].forEach(evt => els['dropzone'].addEventListener(evt, (e) => {
  e.preventDefault(); els['dropzone'].classList.add('drag-over');
}));
['dragleave', 'drop'].forEach(evt => els['dropzone'].addEventListener(evt, (e) => {
  e.preventDefault(); els['dropzone'].classList.remove('drag-over');
}));
els['dropzone'].addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));

// ---------------- Detail view ----------------
async function openDetail(id) {
  showLoading();
  const book = await InkDB.getBook(id);
  if (!book) { await hideLoading(); return; }
  currentDetailBookId = id;
  els['detail-cover'].src = book.coverImage;
  els['detail-title'].textContent = book.title;
  els['detail-meta'].textContent = `${book.format.toUpperCase()} · Added ${new Date(book.addedDate).toLocaleDateString()}`;
  if (book.finished) els['detail-progress'].textContent = 'Finished';
  else if (book.progress > 0) els['detail-progress'].textContent = `${Math.round(book.progress * 100)}% read`;
  else els['detail-progress'].textContent = 'Not started yet';
  els['detail-favorite'].classList.toggle('is-active', !!book.favorite);
  els['detail-favorite'].textContent = book.favorite ? 'Favorited' : 'Favorite';
  els['detail-start'].textContent = (book.progress > 0 && !book.finished) ? 'Continue Reading' : 'Start Reading';
  switchView('view-detail');
  await hideLoading();
}

document.getElementById('detail-start').addEventListener('click', () => startReading(currentDetailBookId));

els['detail-favorite'].addEventListener('click', async () => {
  const book = await InkDB.getBook(currentDetailBookId);
  if (!book) return;
  const updated = await InkDB.updateBook(currentDetailBookId, { favorite: !book.favorite });
  els['detail-favorite'].classList.toggle('is-active', !!updated.favorite);
  els['detail-favorite'].textContent = updated.favorite ? 'Favorited' : 'Favorite';
  refreshBooks();
});

document.getElementById('detail-download').addEventListener('click', async () => {
  const book = await InkDB.getBook(currentDetailBookId);
  if (!book) return;
  const url = URL.createObjectURL(book.fileBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${book.title}.${book.format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

document.getElementById('detail-delete').addEventListener('click', async () => {
  const book = await InkDB.getBook(currentDetailBookId);
  if (!book) return;
  if (!confirm(`Delete "${book.title}"? This cannot be undone.`)) return;
  showLoading();
  await InkDB.deleteBook(currentDetailBookId);
  switchView('view-home');
  await refreshBooks();
  await hideLoading();
});

// ---------------- Reader ----------------
function setActiveThemeBtn(theme) {
  document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
}

function updateReaderProgressUI(fraction) {
  const pct = Math.max(0, Math.min(1, fraction || 0));
  els['reader-progress-fill'].style.width = Math.round(pct * 100) + '%';
  els['reader-progress-label'].textContent = Math.round(pct * 100) + '%';
}

// A single shared timer means switching books (or closing the tab) within the
// 500ms debounce window would otherwise clearTimeout() a still-pending write
// and silently drop that last page-turn. Tracking the pending write itself
// lets any of those moments flush it immediately instead of discarding it.
let pendingSave = null;

function saveProgressDebounced(id, fraction, locationValue) {
  pendingSave = { id, fraction, locationValue };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushProgressSave, 500);
}

function flushProgressSave() {
  clearTimeout(saveTimer);
  if (!pendingSave) return;
  const { id, fraction, locationValue } = pendingSave;
  pendingSave = null;
  InkDB.updateBook(id, { progress: fraction, currentLocation: locationValue, lastOpened: Date.now() });
}

document.addEventListener('visibilitychange', () => { if (document.hidden) flushProgressSave(); });
window.addEventListener('pagehide', flushProgressSave);

async function startReading(id) {
  if (!id) return;
  showLoading();
  const book = await InkDB.getBook(id);
  if (!book) { await hideLoading(); return; }
  currentReaderBookId = id;
  els['reader-title'].textContent = book.title;

  const theme = settings.defaultTheme;
  els['view-reader'].classList.remove('theme-light', 'theme-sepia', 'theme-dark');
  els['view-reader'].classList.add('theme-' + theme);
  setActiveThemeBtn(theme);
  els['finish-btn'].hidden = true;

  const orientation = book.readingOrientation || settings.defaultOrientation;

  // Switch to the reader view before rendering — pdf.js/epub.js measure the
  // container's size, which is 0x0 while its section is still hidden. The
  // loading overlay (higher z-index) still covers this until render finishes.
  switchView('view-reader');

  await InkReader.open(book, {
    orientation, theme,
    callbacks: {
      onProgress: (fraction, atEnd, locationValue) => {
        updateReaderProgressUI(fraction);
        els['finish-btn'].hidden = book.finished || !(atEnd || fraction >= 0.995);
        saveProgressDebounced(id, fraction, locationValue);
      }
    }
  });

  await hideLoading();
}

els['orientation-toggle'].addEventListener('click', async () => {
  const next = InkReader.getOrientation() === 'horizontal' ? 'vertical' : 'horizontal';
  showLoading();
  await InkReader.setOrientation(next);
  if (currentReaderBookId) InkDB.updateBook(currentReaderBookId, { readingOrientation: next });
  await hideLoading();
});

document.querySelectorAll('.theme-btn').forEach(btn => btn.addEventListener('click', () => {
  const t = btn.dataset.theme;
  InkReader.setTheme(t);
  els['view-reader'].classList.remove('theme-light', 'theme-sepia', 'theme-dark');
  els['view-reader'].classList.add('theme-' + t);
  setActiveThemeBtn(t);
}));

document.getElementById('reader-prev').addEventListener('click', () => InkReader.prev());
document.getElementById('reader-next').addEventListener('click', () => InkReader.next());

document.addEventListener('keydown', (e) => {
  if (document.getElementById('view-reader').hidden) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') InkReader.next();
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') InkReader.prev();
});

els['finish-btn'].addEventListener('click', async () => {
  if (!currentReaderBookId) return;
  showLoading();
  pendingSave = null;
  clearTimeout(saveTimer);
  await InkDB.updateBook(currentReaderBookId, { finished: true, progress: 1 });
  InkReader.close();
  await refreshBooks();
  switchView('view-home');
  await hideLoading();
  scrollToSection('section-finished');
});

// ---------------- Search ----------------
els['search-input'].addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  els['search-results'].innerHTML = '';
  if (!q) { els['search-results'].dataset.empty = 'Start typing to search your library.'; return; }
  const matches = byTitle(books.filter(b => b.title.toLowerCase().includes(q)));
  els['search-results'].dataset.empty = 'No books match your search.';
  matches.forEach(b => els['search-results'].appendChild(createCard(b)));
});

// ---------------- Settings ----------------
function updateLibraryStats() {
  els['library-stats'].textContent = `${books.length} book(s) in your library.`;
}

document.querySelectorAll('[data-orientation]').forEach(btn => btn.addEventListener('click', () => {
  settings.defaultOrientation = btn.dataset.orientation;
  saveSettings();
  document.querySelectorAll('[data-orientation]').forEach(b => b.classList.toggle('active', b === btn));
}));

document.querySelectorAll('[data-def-theme]').forEach(btn => btn.addEventListener('click', () => {
  settings.defaultTheme = btn.dataset.defTheme;
  saveSettings();
  document.querySelectorAll('[data-def-theme]').forEach(b => b.classList.toggle('active', b === btn));
}));

document.getElementById('clear-library-btn').addEventListener('click', async () => {
  if (!confirm('Delete all uploaded books? This cannot be undone.')) return;
  showLoading();
  await InkDB.clearAll();
  await refreshBooks();
  await hideLoading();
});

// ---------------- Backup & restore ----------------
// Books live only in this browser's IndexedDB — clearing site data, switching
// browsers, or a fresh OS install wipes them with no server copy to recover
// from. Export bundles every file plus its metadata into one .zip so a user
// can keep an actual copy of their library outside the browser.
async function exportLibrary() {
  if (books.length === 0) {
    alert('Your library is empty — nothing to export yet.');
    return;
  }
  showLoading();
  try {
    const zip = new JSZip();
    const manifest = [];
    for (const book of books) {
      const fileName = `files/${book.id}.${book.format}`;
      zip.file(fileName, book.fileBlob);
      manifest.push({
        title: book.title, format: book.format, coverImage: book.coverImage,
        addedDate: book.addedDate, lastOpened: book.lastOpened, favorite: book.favorite,
        finished: book.finished, progress: book.progress, currentLocation: book.currentLocation,
        readingOrientation: book.readingOrientation, file: fileName
      });
    }
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'inkforge-backup.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (err) {
    console.error('Export failed', err);
    alert('Export failed — see the browser console for details.');
  }
  await hideLoading();
}

async function importLibrary(file) {
  showLoading();
  try {
    const zip = await JSZip.loadAsync(file);
    const manifestEntry = zip.file('manifest.json');
    if (!manifestEntry) throw new Error('That file is not a valid InkForge backup.');
    const manifest = JSON.parse(await manifestEntry.async('string'));
    let imported = 0;
    for (const entry of manifest) {
      const fileEntry = zip.file(entry.file);
      if (!fileEntry) continue;
      const fileBlob = await fileEntry.async('blob');
      await InkDB.addBook({
        title: entry.title, format: entry.format, fileBlob, coverImage: entry.coverImage,
        addedDate: entry.addedDate || Date.now(), lastOpened: entry.lastOpened || null,
        favorite: !!entry.favorite, finished: !!entry.finished, progress: entry.progress || 0,
        currentLocation: entry.currentLocation || null, readingOrientation: entry.readingOrientation || null
      });
      imported++;
    }
    await refreshBooks();
    alert(`Imported ${imported} book(s) from backup.`);
  } catch (err) {
    console.error('Import failed', err);
    alert('Import failed: ' + err.message);
  }
  await hideLoading();
}

document.getElementById('export-library-btn').addEventListener('click', exportLibrary);
document.getElementById('import-library-btn').addEventListener('click', () =>
  document.getElementById('import-file-input').click());
document.getElementById('import-file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) importLibrary(file);
  e.target.value = '';
});

// Asks the browser not to silently evict this site's IndexedDB data under
// disk pressure. Best-effort — still not a substitute for exporting backups.
async function requestPersistentStorage() {
  const statusEl = document.getElementById('storage-persist-status');
  if (!statusEl) return;
  if (!navigator.storage || !navigator.storage.persist) {
    statusEl.textContent = 'This browser doesn’t support persistent storage — back up regularly to be safe.';
    return;
  }
  try {
    const granted = (await navigator.storage.persisted()) || (await navigator.storage.persist());
    statusEl.textContent = granted
      ? 'Persistent storage is enabled — the browser won’t auto-clear this data to free up disk space.'
      : 'The browser did not grant persistent storage — your data could still be cleared under low disk space. Back up regularly.';
  } catch (e) {
    statusEl.textContent = 'Could not determine persistent-storage status.';
  }
}

// ---------------- Download page (website only) ----------------
const RELEASE_VERSION = '1.2.0';
const RELEASE_BASE = 'https://github.com/mrdubya5995-star/INKFORGE/releases/download/v1.2.0/';
const DOWNLOAD_LINKS = {
  mac: { url: RELEASE_BASE + 'InkForge-macOS.dmg', size: '97.2 MB' },
  windows: { url: RELEASE_BASE + 'InkForge-Setup-Windows.exe', size: '80.6 MB' },
  linux: { url: RELEASE_BASE + 'InkForge-Linux.AppImage', size: '102.7 MB' }
};

function setupDownloadLinks() {
  ['mac', 'windows', 'linux'].forEach(p => {
    document.getElementById(`download-${p}`).href = DOWNLOAD_LINKS[p].url;
    document.getElementById(`download-${p}-version`).textContent = `v${RELEASE_VERSION} · ${DOWNLOAD_LINKS[p].size}`;
  });
}

// The Electron build loads this exact same index.html — a runtime check
// rather than a separate copy, so the app and website never drift apart.
function applyElectronRestrictions() {
  if (!IS_ELECTRON) return;
  document.getElementById('download-toggle').remove();
  const backupGroup = document.getElementById('backup-restore-group');
  if (backupGroup) backupGroup.remove();
}

// ---------------- Init ----------------
(async function init() {
  document.querySelectorAll('[data-orientation]').forEach(b =>
    b.classList.toggle('active', b.dataset.orientation === settings.defaultOrientation));
  document.querySelectorAll('[data-def-theme]').forEach(b =>
    b.classList.toggle('active', b.dataset.defTheme === settings.defaultTheme));
  setupDownloadLinks();
  applyElectronRestrictions();
  setupShelfScrollbars();
  await refreshBooks();
  requestPersistentStorage();
})();
